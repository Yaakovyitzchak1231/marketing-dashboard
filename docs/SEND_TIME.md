# Send-time optimisation (plan 3.11)

Per-lead "best time to send", learned from when a lead actually replied or clicked.

> **Status: the learning is live, the scheduling is not.** The nightly job learns and stores windows,
> and the campaign lead preview shows them. Nothing in production moves a send time yet:
> `resolveSendTime` (`lib/sendtime/schedule.ts`) has no production caller. See
> [Where it plugs in (not active yet)](#where-it-plugs-in-not-active-yet).

## What it stores

| Table | One row per | Holds |
|---|---|---|
| `lp.lead_send_windows` | lead | `best_hour` (0-23), `best_dow` (Mon-Fri or null), `timezone` + `timezone_source`, `sample_size`, `last_engagement`, `basis` |
| `lp.campaign_send_windows` | campaign | the same, learned over all of the campaign's leads: the fallback |

Both are derived caches rebuilt nightly. Migration: `db/migrations/0063_send_windows.sql` (tables and the job seed).

### Lead keys

A lead key is `contact:<id>` when the lead is a contact, else `company:<id>`. That is the shape main
already uses (`lp.trigger_watch.member_key` in `db/migrations/0053_journey_triggers.sql`, built by
`memberKey` in `lib/triggers/match.ts`; the composite-event dedupe keys in `lib/events/composite.ts` end
in the same `contact:<id>`). `lib/sendtime/lead-key.ts` is the only code that builds or parses one
(`leadKey`, `parseLeadKey`). The `<company_id>:<contact_id>` composite used by the unmerged A/B
experiments branch (`0061` `experiment_assignments`) is not on main and is a different thing (a company
and a contact, where a window belongs to one lead); join through `parseLeadKey` if both ever meet.

## What it learns from

- **Replies and clicks only.** `reply_received` weighs 3, `email_link_clicked` weighs 2
  (`ENGAGEMENT_WEIGHTS` in `lib/sendtime/config.ts`). Opens are excluded entirely:
  1. Apple Mail Privacy Protection and security scanners fire opens at machine times, and the Instantly
     webhook marks every open `low_trust: true` (`lib/webhooks/instantly.ts`).
  2. An open follows our own send hour: learning from opens would reinforce whatever hour we already used
     (a feedback loop), not find when the person is reading.
  Auto-replies are a separate event type (`auto_reply_received`) and never count. Any event carrying
  `props.low_trust = true` is dropped, whatever its type.
- **`occurred_at`, not `recorded_at`.** The bucket is when the person actually engaged. Ingestion lag
  (webhook retries, the nightly reconcile) must not move a lead's hour. This is the house rule for every
  time-of-day analysis on `lp.lead_events`.
- **Evidence horizon.** Events older than 180 days are ignored (`WINDOW_MAX_AGE_DAYS`). The nightly
  batch revisits leads that engaged in the last 90 days (`DISCOVERY_DAYS`).

## How a window is picked (`pickWindow`)

- **Minimum sample 8** (`MIN_SAMPLE`) engagement events, else no window. `sample_size` is the raw event
  count, so "learned from N replies and clicks" is literally true.
- **Hour:** the 24 weighted hourly totals are smoothed with a circular `[1, 2, 1]` kernel (each hour also
  counts its neighbours, 23 and 0 included), then the best hour wins. A lead active at 10 and 11 peaks
  between them; one stray 3am click cannot beat a cluster. Ties go to the hour nearest the middle of
  business hours (13:00), then the earlier hour. They never resolve to the lowest hour (midnight).
- **Day:** Monday to Friday only (business outreach). A day is claimed only when the best weekday has at
  least 1.5x the average day (over all seven days, so a mostly-weekend lead does not get a "best
  weekday" out of two stray events). Otherwise `best_dow` is null. Weekend engagement still counts for the
  hour, never for the day. A CHECK constraint keeps weekend values out of the tables, and the scheduler
  ignores one if it ever sees it.

## Fallbacks, in order

1. **The lead's own window** (`basis = 'own'`).
2. **A contact borrows its company.** A contact with fewer than 8 events of its own is learned from
   its company's events too (`contact_id = N or company_id = C`) and stored with `basis = 'company'`.
   A contact with enough of its own evidence uses only its own.
3. **The campaign window.** `resolveSendTime(..., { campaignId })` falls back to
   `lp.campaign_send_windows`: the same learning over the engagement of every lead in the campaign
   (`lp.campaign_leads` rows plus events tagged with the campaign), in the default timezone.
4. **Nothing.** The due time passes through unchanged and `window` is `null`.

## Staleness

A window records `last_engagement`, the newest event it was learned from. A window older than 180 days
is **expired** and treated as absent by `resolveSendTime`, the `sendtime_window` op and the lead preview.
When a lead's evidence drops below the minimum, the recompute writes nothing and reports the lead as
skipped; the old row stays but expires on its own. Nothing is presented as current when it is not.

## Timezone: honest about the default

No lead record carries a timezone today, so every window is bucketed in `America/New_York`. It is
labelled that way: `timezone_source` is `'default'` (assumed) or `'lead'` (a real timezone was
supplied), and the lead preview shows "ET (assumed)" for the former.

A timezone string is validated (`lib/sendtime/tz.ts`) before it reaches Postgres `at time zone` or
`Intl`: IANA names only, checked with `Intl.DateTimeFormat`. Offset strings such as `+05:00` are rejected
because Intl and Postgres read them with opposite signs. An invalid value falls back to the default and is
labelled `'default'`; nothing errors. The scheduler never throws on a bad timezone: it returns the due
time unchanged.

## Turning a window into a send time (`optimalSendAt`, `resolveSendTime`)

- The learned hour is clamped into **8:00-18:00 lead-local** (`QUIET_HOURS_*`), whatever it is.
- The send is the next occurrence of that hour. If the lead has a `best_dow`, the send moves to that
  weekday when it is **within 48 hours** of the due time (`MAX_SHIFT_HOURS`). A weekday further out is
  dropped, and the send falls back to the **clamped best-hour time** (at most about a day out, always
  inside business hours). It never falls back to the raw due time, which could be 3am.
- Day arithmetic is wall-clock and the UTC offset is re-derived at the result, so DST is handled: a step
  due at 02:00 local on a US spring-forward day (a time that does not exist) resolves to a real instant
  inside business hours (08:00 EDT = 12:00Z). Tested in `tests/sendtime.test.ts`.
- The hour-only shift does not skip weekends: which days a campaign sends is the sender's schedule, not
  this module's.
- Result: `{ send_at, shifted, window, source }`, where `source` is `'lead'`, `'campaign'` or `null`.

## The nightly job

`db/migrations/0063_send_windows.sql` seeds one `lp.jobs` row:

| Field | Value |
|---|---|
| name / kind | `sendtime_recompute` / `ops_call` (generic handler, `runner/handlers/ops_call.mjs`) |
| schedule | `17 3 * * *`, timezone `UTC` |
| payload | `{"op":"sendtime_recompute","args":{}}` |
| timeout | 900 s; `next_run_at` seeded to the next 03:17 UTC (the runner only claims jobs that have one) |

It is `on conflict (name) do nothing`, so an owner's edits survive a re-run. The runner calls the op as
the `system` actor, which is not role-gated (`lib/ops/actor-role.ts`); a human's key needs Editor.

`sendtime_recompute` (`lib/sendtime/ops.ts`, `recomputeSendWindows`) covers leads that engaged in the
last 90 days, most recent first, up to `limit` (default 500, max 5000), then the campaign windows. It
returns `{ recomputed, skipped, campaigns_recomputed, campaigns_skipped }`, and the report matches what
was stored: a lead counts as `recomputed` only when a row was written, `skipped` when its evidence was
below the minimum.

- **Contact-only leads are covered.** An event with a contact but no company is keyed `contact:<id>`.
  With `campaign_id`, a lead is in scope if it is in `lp.campaign_leads` (by company or pinned contact)
  or the event is tagged with the campaign.
- **Paging is keyset**, on `(last_engagement desc, lead_key asc)`: the key breaks ties, and a cursor
  (not `OFFSET`) means a page never skips or repeats a lead. The last page asks for only what is left of
  `limit`.

Other ops: `sendtime_window {company_id?, contact_id?}` returns a lead's window (relearning when missing
or expired; `null` with too little evidence).

## Where it plugs in (not active yet)

`resolveSendTime(db, companyId, contactId, dueAt, { campaignId })` is the seam. Searched on main for a
place that computes a next-send time for a campaign step or lead:

- **Campaign steps** (`lib/campaign-steps/`) store `delay_days` only and push it to Instantly
  (`lib/campaign-steps/instantly.ts`). Instantly owns when each email goes out; the dashboard never
  computes a per-lead due time.
- **The Instantly send path** (`lib/instantly/`) adds leads to a campaign; it has no per-lead send time.
- **Journeys:** only goals and recipes (`lib/journeys/`) are on main. The executor that would hold a
  step's due time (plan 3.1) is not merged.

So there is no single place on main to wire it in, and **it is not wired in**. No per-campaign opt-in
setting exists for the same reason. When a journey executor (or any per-lead send scheduler) lands, it
should call `resolveSendTime` where it turns "step N is due at T" into a dispatch time, behind a
per-campaign setting that defaults to off, and pass the campaign's id so the fallback applies. Until
then the windows are informational: the campaign lead preview shows them
(`components/campaign-steps/LeadPreview.tsx`) and says so.

## Files

- `lib/sendtime/config.ts`: every tunable (weights, minimum sample, age limit, business hours, shift cap).
- `lib/sendtime/lead-key.ts`: the lead key helper and `SendTimeError`.
- `lib/sendtime/tz.ts`: timezone validation and the labelled default.
- `lib/sendtime/analyze.ts`: bucketing, window learning, the batch recompute.
- `lib/sendtime/schedule.ts`: `optimalSendAt`, `resolveSendTime`.
- `lib/sendtime/ops.ts`: the `sendtime_window` and `sendtime_recompute` ops.
- `tests/sendtime.test.ts`: unit, database and job-path tests.
