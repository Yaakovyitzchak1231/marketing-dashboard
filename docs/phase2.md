# Phase 2: Reports and actions

Everything here is free: no paid API, no new service. Every number comes from
Instantly, the lead database or the cost table you type in; anything nobody
reported shows **no data**, never 0.

Nav: **Reports** (`/reports`) holds the four pieces below.

## 1. Lead runway — `/reports/runway`

- **Per campaign** (Instantly): leads loaded but not yet contacted, new leads
  contacted in the last 7 days, the pace per day (that ÷ 7 calendar days) and
  how many days the loaded leads last. Paused/draft campaigns say "Not sending".
- **Per segment** (jewelers / AI agencies): verified, never-emailed leads in the
  database that are in no campaign yet + loaded-not-contacted in that segment's
  campaigns, divided by the combined pace of its active campaigns.
- Under **14 days** gets a warning (also on `/reports` and in the weekly one-pager).
- Buttons: **Find more leads** (opens Find leads with the segment picked),
  **Verify N unverified** (the existing free check → cost preview → Approve),
  **Pause / Resume** a campaign (confirm click).
- A campaign counts toward a segment once its segment is set under
  *Cost per meeting → Campaign angle and segment*. Nothing is guessed from names
  (the name only fills the placeholder).

## 2. Cost per meeting — `/reports/costs`

- Reply rate, interested, meetings (Instantly) by **angle** and by **campaign**
  for 7 / 30 / 90 days, with cost, cost per reply and cost per meeting.
- **Monthly costs** table (Postgres `lp.monthly_costs`): month, category
  (inboxes, tools, verification, lead data, other), what, amount, optionally a
  campaign. Amounts are prorated by day to the selected range; costs with no
  campaign are split across campaigns by emails sent.
- Zero meetings → "no meetings yet" (not infinity); an unreported count → "no data".
- Paid verification recorded by verification runs is shown beside the table; it is
  only counted if you add it as a row (no double counting).

## 3. Weekly one-pager — `/reports/weekly`

- Last 7 days vs the 7 before: sends, new leads contacted, replies, reply rate,
  interested, meetings, bounces, bounce rate; best and worst angle (only angles
  with 50+ leads contacted are ranked); runway; open items (low runway, replies
  waiting on us, approvals waiting, open Team tasks).
- **Assign follow-up** on any item creates a Team task for the agent you pick
  (deduplicated per item).
- **Print / save as PDF** uses the browser's print dialog (nav and buttons hide).
- **For agents:** `GET /api/ops/reports/weekly?format=json|md` with
  `Authorization: Bearer <agent token>` (OPS_AGENT_TOKENS). Signed-in humans:
  `/api/reports/weekly?format=md`.

## 4. Lead Master copy (read-only) — card on `/reports`

- Writes the lead database back out: one row per contact with an email (company,
  segment, stage, statuses, verification, latest campaign event…), ordered by id.
- **CSV**: "Download CSV" on `/reports`, `GET /api/ops/export/lead-master` (agent
  token or cron secret), or `npm run export:lead-master -- --csv out.csv`.
- **Sheet**: writes ONLY a tab named `DB export (read-only)` (any name starting
  with "DB export"; set `LEAD_MASTER_EXPORT_TAB` to change it). It is created if
  missing and fully overwritten each run, so running it again is safe. The
  Lead Master **Leads** tab (append-only) and every other tab are never read or
  changed; the code refuses any other tab name before making a request.
- Every run is logged (`lp.exports`) and listed on `/reports`.

### Scheduling the Lead Master copy

Pick one:

1. **Vercel Cron** (free on Hobby, once a day): add to `vercel.json`
   ```json
   { "crons": [{ "path": "/api/ops/export/lead-master?to=sheet", "schedule": "0 7 * * *" }] }
   ```
   and set `CRON_SECRET` in Vercel (Vercel sends it as `Authorization: Bearer …`).
2. **OVH server cron** (any frequency):
   ```
   15 * * * * cd /opt/marketing-dashboard && DATABASE_URL=... LEAD_MASTER_SHEET_ID=... \
     GOOGLE_SERVICE_ACCOUNT_JSON="$(cat /etc/tapdash/sa.json)" npm run -s export:lead-master -- --sheet
   ```
3. **An agent** (Tab/Hermes) on its own schedule: `POST /api/ops/export/lead-master` with its token.

Google access (free): create a service account in Google Cloud, enable the
Sheets API, download its JSON key into `GOOGLE_SERVICE_ACCOUNT_JSON`, and share
the Lead Master Sheet with the service account's email as **Editor**.
(`GOOGLE_ACCESS_TOKEN`, a 1-hour OAuth token, works for a one-off manual run.)

## Instantly actions (your click only)

| Where | Button | What it does |
|---|---|---|
| Leads (bulk bar) | Add to Instantly | Pick a campaign → preview: who is ready (verified, not do-not-contact, not already in Instantly — looked up read-only — and never in a campaign in our records) and who is left out and why → **Add N** → confirm. Sends only the previewed list, at most 1000 per call, with `skip_if_in_workspace`. Each added lead gets status `in-Instantly` and a campaign touch; the Activity feed says what Instantly answered. |
| Runway | Pause / Resume | Confirm → `POST /campaigns/{id}/pause` or `/activate`. |
| Weekly | Assign follow-up | Team task for an agent. |
| Replies | (unchanged) | Approve-before-send stays as it was. |

- Only these Instantly calls exist in the code: pause, activate, leads/add
  (`lib/instantly/writer.ts`, allowlisted). The read-only client stays read-only.
- They run only from the signed-in dashboard (server actions). Agents' ops API
  has no Instantly writes; nothing runs on a schedule.
- A confirmed preview is never sent twice (double click / refresh / retry are no-ops).
  If Instantly doesn't answer or errors 5xx, the action is marked
  "outcome unknown, check Instantly" and is not resent automatically.
- Every change is recorded in `lp.instantly_actions` and the Activity feed.

## Env vars (all optional)

| Name | For |
|---|---|
| `INSTANTLY_WRITE_API_KEY` | A key with `campaigns:update` + `leads:create` if `INSTANTLY_API_KEY` is read-only. |
| `INSTANTLY_ACTIONS=off` | Turns every Instantly button off. |
| `LEAD_MASTER_SHEET_ID` | The Lead Master Sheet id (for the Sheet copy). |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account key JSON (Sheet copy on a schedule). |
| `LEAD_MASTER_EXPORT_TAB` | Export tab name; must start with "DB export". |
| `CRON_SECRET` | Lets Vercel Cron call the export route. |

## Database

`db/migrations/0005_phase2.sql` (additive): `lp.campaign_meta`,
`lp.monthly_costs`, `lp.instantly_actions`, `lp.exports`. Run
`npm run db:migrate` as before. It does not depend on the SEO migration (0004).
