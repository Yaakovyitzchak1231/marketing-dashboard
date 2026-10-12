# Journeys: model, versions and the runner (plan 3.1)

A journey moves leads through a graph of steps: wait, then do something, then
branch, and so on. This file is the contract the other Phase 3 rows build on
(3.3 delayed triggers, 3.4 waits, 3.5 branches, 3.7 goals and exits, 3.8
actions, 3.9 sends, 3.12 frequency caps). Nothing in 3.1 sends email.

## Tables (`db/migrations/0057_journeys.sql`)

- `lp.journeys` — id, name, `status` (draft | testing | live | paused | sunset),
  `campaign_id`, `trigger_id` (a 3.2 trigger that enrols leads), `trigger_cursor`
  (last `lp.trigger_fires.id` consumed), `entry_mode` (once | multiple),
  `goal` jsonb (`{exit_event?}`, see Goals and exits), `settings` jsonb (`{entry_cap?}`), `current_version`.
- `lp.journey_versions` — (journey_id, version) → `graph` jsonb, note,
  published_by, published_at. Publishing never edits a version; it adds one.
- `lp.journey_runs` — one row per lead per pass through a journey: journey_id,
  `version` (fixed at entry), company_id and/or contact_id, `node_id`,
  `node_entered_at`, `status` (active | waiting | done | exited | goal | error),
  `next_run_at` (when the runner looks at it next), entered_at, finished_at,
  `source` (manual | segment | trigger | api), trigger_fire_id, `context` jsonb,
  last_error. At most one open (active/waiting) run per lead per journey, and
  one run per trigger fire.
- `lp.journey_steps_log` — every step a run takes: run_id, node_id, `action`,
  `result` jsonb, actor, at.
- Event types `journey_entered` and `journey_finished` (lead events, with
  `props.journey_id`, `run_id`, `version`, and `status` on finish), so the
  timeline and 3.2 triggers see them.
- Job `journey_tick` (kind `ops_call`, every minute) calls `run_journeys`.

## Status

| status | new leads | runs advance |
| --- | --- | --- |
| draft | no | — |
| testing | manual / API enrol only | yes |
| live | trigger fires, manual, segment, API | yes |
| paused | no | no (they stay put) |
| sunset | no | yes, until they finish |

Testing and live need a published version. Back to draft only when no run is open.

## The graph (`lib/journeys/graph.ts`)

```json
{ "start": "hello",
  "nodes": [
    { "id": "hello", "kind": "note", "next": "pause" },
    { "id": "pause", "kind": "wait", "config": { "days": 3 }, "next": "check" },
    { "id": "check", "kind": "branch", "config": {}, "paths": [
        { "label": "opened", "to": "done" }, { "label": "no open", "to": "bye" } ] },
    { "id": "done", "kind": "note" },
    { "id": "bye", "kind": "exit", "config": { "reason": "never opened" } } ] }
```

`next` is where the run goes when a node finishes (missing: the run ends as
`done`). `paths` are labelled edges for nodes that choose. `validateGraph`
checks shape, unique ids, known kinds, each kind's own config, that every edge
points at a node, and that every node is reachable. Loops are allowed.

Built-in kinds (`lib/journeys/nodes.ts`): `wait` ({minutes, hours, days},
measured from `node_entered_at`), `exit` ({reason}; ends as `exited`),
`note` (does nothing; moves on), `branch` (3.5, below), `goal` and `goto` (3.7, below),
and `ab_split` (3.6, `lib/journeys/ab-split.ts`, config {experiment_id, variants}), which routes a
lead down the path named after its A/B variant: [experiments.md](experiments.md).

## Branch nodes (plan 3.5)

A `branch` picks one of its labelled `paths`; it never uses `next`. Config:
`{ if?, since? }`. Path labels are matched ignoring case, and the graph is
rejected at publish (and by `journey_validate`) when the labels a mode needs are
missing. A branch never falls through to "some other path".

`since` is `journey` (default: events from the lead's entry into the journey) or
`node` (events from when the run arrived at this branch). Anything else is
rejected. Events are measured on `occurred_at` (when it happened), not
`recorded_at` (when we stored it), so an open from before entry that a backfill
stores later does not count.

Whose events count follows the 3.7 rule: a branch on a contact's run counts only
that contact's events, and a branch on a company's run counts that company's. A
colleague at the same company opening, clicking or replying does not move a
contact's run.

**Open/click** (no `if`): paths `clicked` and/or `opened`, plus a fallback
`no-open` (or `no open`, `else`, `no`). A lead with an `email_link_clicked` takes
`clicked` (or `opened` if there is no `clicked` path); one with only an
`email_opened` takes `opened`; if the graph has no path for what happened, or
nothing happened, the lead takes the fallback (`else` preferred for the former).

**If/else** (`if` set): paths `yes` (or `true`) and `no` (or `else`). Two forms:

- `{ "event": "reply_received" }` — yes when that event type happened since `since`.
- `{ "entity": "company"|"contact", "field": "...", "equals": ... }` — yes when the
  field equals the value. Fields: company `stage`, `city`, `state`, `country`;
  contact `status`, `verification_status`. `equals` is required, and compared as text.

NULL is "unknown", never `''`: a missing row or a NULL column is `no`, unless
`equals` is explicitly `null`, which matches only a NULL column. Unknown `if`
keys, an unknown entity, a non-whitelisted field, or an empty `if` are rejected.

```json
{ "id": "gate", "kind": "branch", "config": { "if": { "event": "reply_received" }, "since": "node" },
  "paths": [ { "label": "yes", "to": "thanks" }, { "label": "no", "to": "nudge" } ] }
```

Graphs are validated by `publishVersion` before anything is stored (the only
writer of `lp.journey_versions`); `journey_upsert` stores no graph.

## Goals, go-to, exits and the entry cap (3.7)

- **`goal` node** `{event?}` — ends the run with status `goal`. With no `event` it
  finishes as soon as the run reaches it. With an `event` (a lead event type, like
  `meeting_booked`) it waits, re-checking every minute, until that event has
  happened for the lead since the run entered, then finishes as `goal`.
- **`goto` node** `{to}` — jumps to the node id in `to` (surrounding spaces are
  trimmed when the graph is validated). The graph counts it as an edge, so the
  target must exist (`node 'x' points at unknown node 'y'` otherwise) and is
  reachable. Loops through a `goto` are allowed; the 50-steps-per-advance cap applies.
- **Journey `goal.exit_event`** (set with `journey_upsert` `goal: {exit_event: 'lead_unsubscribed'}`)
  — on the next tick, every open run of a live, testing or sunset journey whose
  lead has had that event since the run entered is exited (status `exited`, step
  log `exit_criteria`), even in the middle of a wait that is not due. One bounded
  query per tick (at most the tick's `limit` runs; the rest go on the next tick).
- **Matching** — events are matched by `occurred_at` (not the time they were
  recorded). A contact run matches events for that contact; a company run
  matches events for that company. A company-level event does not exit a run
  that belongs to a contact.
- **`settings.entry_cap`** (integer >= 1) — the most times one lead may enter this
  journey, counted over all runs that cover the lead (open or finished, not just
  open ones), at the same grain as `entry_mode`: a company-level run counts for
  that company's contacts and the other way round. Past the cap, enrol returns `enrolled: false` with reason
  `already_entered`. `entry_mode: once` is the same as a cap of 1 and is checked
  first. Entries for one journey are serialised with a transaction-scoped
  advisory lock (`pg_advisory_xact_lock`) so two parallel enrols cannot both pass
  the check at cap - 1.

## Adding a node kind (3.4, 3.5, 3.7, 3.8, 3.9)

Write a `NodeHandler` and register it (`registerNodeHandler`, or add it to
`BUILT_IN` in `lib/journeys/nodes.ts`):

```ts
{ kind: 'branch',
  validate(node) { return node.paths.length ? [] : ['add at least one path'] },
  async run({ q, run, node, graph, now }) {
    // read lead_events since run.node_entered_at, segment membership, ...
    return { type: 'next', path: 'opened' }
  } }
```

A handler returns one outcome and the runner does the bookkeeping:

- `{ type: 'next', path?, to?, result?, context? }` — move on (to `next`, a
  labelled path, or a node id; `to` is how 3.7's go-to works).
- `{ type: 'wait', until, result?, context? }` — stay here; the handler runs
  again at `until`. 3.4's "wait, but drop if they replied" is a wait handler
  that checks `lp.lead_events` since `run.node_entered_at` and returns
  `{ type: 'finish', status: 'exited' }` when a drop event is there. 3.12's
  over-cap send can return a `wait` until the next allowed slot.
- `{ type: 'finish', status: 'done' | 'exited' | 'goal', result? }` — end the run.

`context` merges into `run.context` (per-run memory, e.g. a 3.3 `cancel_on`
list). One advance takes at most 50 steps, then resumes next tick.

### When a handler throws

Each node commits on its own (`advanceOnce`): a node that moves the run on commits
the move before the next node starts. A handler that throws rolls back only its
own node, so the run is still on the node that failed and earlier nodes of the
same tick stay done. The runner counts the failure (`attempts`) and retries after 1, then 5 minutes.
After three failures in a row the run goes to `error` with `last_error`. The
count goes back to zero whenever the run commits progress (a wait, a move past a
node, a finish), so failures far apart never add up. Each attempt is a `retry` or
`error` row in the step log. An errored run is re-opened by hand with
`journey_retry`; it resumes at the same node with the count reset. A run whose
lead cannot be reached because the DB is down is left open and tried again on the
next tick. Other runs in the same tick are not affected.

### Side effects (read before writing a send, push or HTTP node)

A handler's writes through `q` roll back with its own node. Nodes the run already
passed stay committed. Anything outside the database does not roll back at all: if a
handler sends an email or calls Instantly and then throws, the effect has happened,
the run stays on the node, and the retry repeats it. So an external effect must be
idempotent:

- pass `ctx.idempotencyKey` (`journey-run:<run_id>:<node_id>:<visit>`) to the outside
  service as its idempotency key. `visit` is `lp.journey_runs.visit`: 1 on entry, plus 1
  each time the run commits a move to a node. It is the same on every retry of one
  visit (a failed node commits nothing, so it does not move), and new on every later
  visit, even a loop that returns to the node within one tick. It is a runner-owned
  column, not part of `context`, so a node cannot overwrite it;
- make the call the last thing the handler does.

If the service has no idempotency key, the node is at-least-once: say so in the
node's docs. Set `sends: true` on the handler (see the `NodeHandler` comment in
`lib/journeys/nodes.ts`) for any kind that sends or pushes.

### Suppression and approval

- Enrolment and every step check the lead: a company at stage `do_not_contact`,
  a contact with `do_not_contact` or status `do-not-contact`, or a live
  suppression on its email (`lp.is_suppressed`, for the journey's campaign). A
  blocked lead is not enrolled (`reason: do_not_contact | suppressed`), and a run
  that is blocked mid-wait exits with `exited_suppressed` on its next tick.
  A live domain suppression (`lp.suppressions.domain`, global or for the journey's
  campaign, not lifted or expired) also blocks a company when the domain is its
  website domain or the domain of any email on it, whether the run is for the
  company or one of its contacts. Send nodes must still check suppression at send
  time.
- A `sends: true` node does not run on a version nobody approved. The run waits
  and is checked again in an hour (`awaiting_approval`). Approval is per version
  (`lp.journey_versions.approved_by/approved_at`), set with `journey_approve`
  (Owner only; `version` defaults to the current one). Approving v2 does not
  release a run still on v1; approve v1 for that. The `journeys.approved_*`
  columns only record the most recent approval.
- Going live (`journey_set_status` to `live`) is Owner only.

### Pause, resume and trigger fires

- Pausing records `paused_at` (pausing a paused journey again keeps the first time). Resuming moves every open run's due time forward
  by the length of the pause, so a wait carries on where it was instead of every
  elapsed wait firing at once.
- Going live (from draft, testing, paused or sunset) moves the trigger cursor to
  the newest fire. Fires from before that are not replayed, so a journey does not
  enrol leads from weeks ago. A fire from testing is not consumed on going live.
- A fire whose trigger is disabled when the runner reads it enrols nobody. It is
  reported as skipped and the cursor still moves past it, so enabling the trigger
  again does not replay it.
- One bad fire does not hold the cursor. A lead that is gone or does not match
  (`JourneyError`), or a row Postgres rejects as bad data (error class 22 or 23), is
  skipped and reported, and its writes roll back to a savepoint. Any other error
  (a lock timeout, a dropped connection) fails only that journey's read: the cursor
  stays, the next tick retries the same fires, and other journeys and the due runs
  in the same tick carry on (`trigger_failures`).

### Entry once vs multiple

`entry_mode: once`: a lead enters at most once, ever. `multiple`: again after its last
run ends, never while one is open.

"Lead" is judged at the grain of the run, and a broader run covers a narrower lead:

- a contact is covered by a run for that contact, or by a company-level run for its company;
- a company (enrolled without a contact) is covered by any run of that company, whoever it was for.

So a company never gets the journey twice by being enrolled both ways, and a
company-level run is not followed by a message to each of its contacts. Two
contacts of one company can both be in a contact-level journey. Both modes give
`already_entered` (once) or `already_in` (multiple) in the enrol result. The
one-open-run unique index (`journey_runs_open_lead_uq`) stays as a backstop.

## The runner (`lib/journeys/runner.ts`)

- `enrollLead(q, actor, journeyId, { company_id?, contact_id?, source, context, trigger_fire_id })`
  — inside a transaction. Honours `entry_mode`, `settings.entry_cap` and the one-open-run rule.
- `exitRuns(db, actor, { run_id } | { journey_id, company_id | contact_id })`.
- `advanceRun(db, runId, now)` — locks the run with `FOR UPDATE SKIP LOCKED`,
  so two ticks never move the same run. Each node is its own transaction.
- `runDueJourneys(db, { budgetMs? })` — one tick: enrol from new trigger fires of
  live journeys (a new journey starts from the newest fire, it does not replay old
  ones), then advance due runs of live, testing and sunset journeys, oldest due
  first. A tick stops taking new runs after `TICK_BUDGET_MS` (90 s; the job times
  out at 120 s). Each run commits on its own, so the rest wait for the next tick,
  and the result says `deadline_reached: true`. Before the due runs are picked, the
  tick exits open runs whose journey `goal.exit_event` has happened (at most `limit`
  per tick; `exited_by_criteria` counts them, `exit_criteria_error` is set if that
  step failed, and the due runs still go ahead). `advanceRun` makes the same check
  before each node, so a run also leaves between two nodes.
- Keys the runner sets itself (`journey_entered:<run_id>`, `journey_finished:<run_id>`)
  are reserved: `track_event` refuses a `dedupe_key` with either prefix, so a caller
  cannot pre-claim one and hide the event.

## Ops (agents: `POST /api/ops {op, ...}`)

| op | args | who |
| --- | --- | --- |
| `journey_list` | {campaign_id?, status?} | Viewer+ |
| `journey_get` | {journey_id, version?} | Viewer+ |
| `journey_runs` | {journey_id?, company_id?, contact_id?, status?, limit?} | Viewer+ |
| `journey_run_log` | {run_id} | Viewer+ |
| `journey_validate` | {graph} | Viewer+ |
| `journey_upsert` | {id?, name, campaign_id?, trigger_id?, entry_mode?, goal?, settings?} (an omitted field keeps its value on edit) | Editor+ |
| `journey_publish` | {journey_id, graph, note?} | Editor+ |
| `journey_set_status` | {journey_id, status} (`live` is Owner only) | Editor+; Owner for `live` |
| `journey_approve` | {journey_id, version?} (default: the current version) | Owner |
| `journey_retry` | {run_id} (an errored run only) | Editor+ |
| `journey_enroll` | {journey_id, company_id? / contact_id? / company_ids? / segment_id?, after_company_id?, page_size?, context?, source?: manual or api} | Editor+ |
| `journey_exit` | {run_id} or {journey_id, company_id? / contact_id?}, reason? | Editor+ |
| `run_journeys` | {limit?} | Owner or the runner (`system`) |

`journey_enroll` commits in chunks of 200 leads, with a savepoint per lead. A lead
that fails its own checks (a company that does not exist, a contact in another
company) comes back as `reason: invalid` with an `error`; any other failure for one
lead (the database rejecting its row) comes back as `reason: error`. The other leads
still enrol, and `failed` counts both. A problem with the journey itself (not live
or testing, no version) fails the whole call. `results` lists the first 200 leads and
`results_truncated` says when there are more. `source` is `manual` (default) or
`api`; any other value is refused (`segment` is set by the runner when you pass a
`segment_id`, `trigger` for trigger fires).

A segment is read by keyset pages in SQL: companies with an id above
`after_company_id`, ascending, at most 2000 per call (`page_size` lowers it). Pass
`next_after_company_id` back as `after_company_id` while `more` is true. A lead added
or removed between calls cannot make a page skip or repeat a company. A contact
segment maps to each of its companies once.

Roles apply to keys minted for a person (`lib/ops/actor-role.ts`). Owner-only
checks inside an op (`journey_approve`, `live`) apply to every key, agents too.
Agent keys are otherwise not role-gated, as with every other op.

## Send controls (plan 3.10)

`lib/journeys/send-controls.ts` is the gate a send step calls before it sends.
It does not send. Quiet hours and send windows are in the lead's time zone.
`launch_at` and `active_until` are absolute.

Timezone order: contact `timezone`, then company `timezone`
(`db/migrations/0065_lead_timezone.sql`), then `settings.send_controls.fallback_timezone`,
then `America/New_York`. A blank or unknown name is skipped and never throws.

House rule for the default: Eastern time is the house default zone (the same one the
send-time feature uses). It is never silent. When no contact, company or journey
zone was usable, every decision from `sendAllowed` carries `timezone_defaulted: true`
(the key is absent when a real zone was used), and `resolveLeadTimezoneDetail`
returns `{ timezone, defaulted }`. Fill in the lead's zone, or the journey's
`fallback_timezone`, to turn the flag off.

```json
{ "send_controls": {
    "quiet_hours": { "start": "21:00", "end": "08:00" },
    "fallback_timezone": "America/New_York",
    "send_window": { "days": [1, 2, 3, 4, 5], "start": "09:00", "end": "17:00" },
    "launch_at": "2026-10-14T13:00:00Z",
    "active_until": "2026-11-01T00:00:00Z" } }
```

Days are integers, 0 = Sunday through 6 = Saturday. Times are 24-hour `HH:MM`
with two digits. A start later than the end wraps midnight (a Friday 22:00 to
02:00 window is still open at Saturday 01:00); start and end must differ.
If the journey sets no quiet hours, the caller may pass the workspace quiet-hours
clock. No send window means any time, still subject to quiet hours and the
launch bounds. `launch_at` and `active_until` must be ISO date-times with an
explicit offset or `Z` (`2026-10-14T09:00:00-04:00`); a value with no offset
would be read in the server's zone, so it is refused.

**Bad config is refused at save.** `journey_upsert` checks `settings.send_controls`
and rejects it (400, `settings.send_controls is invalid: ...`, every problem
named) for: a non-object, `days` that is not an array of integers 0 to 6 (a string
like `"1,2,3"`, numeric strings, an empty list), a clock that is not `HH:MM`
(`"9:00"`), a zero-length span, an unknown `fallback_timezone`, or a `launch_at`
or `active_until` that is not an ISO date-time with an offset. Absent or `null`
fields mean "no such control".

**Bad config fails closed at send time.** Config saved before the check, or edited
in the database, may still be malformed. `sendAllowed` does not throw and does not
read a malformed control as "no limit". It holds the send:
`{ allow: false, until: now + 1 hour, reason: "invalid send window", errors }` when the
send window is malformed, and `reason: "invalid send controls"` for any other
malformed field (quiet hours, `launch_at`, `active_until`, or `send_controls`
itself). A bad stored workspace quiet-hours pair (see below) holds with its own
reason, `"invalid workspace quiet hours"`, and `errors` names
`workspace.quiet_hours_start` and `workspace.quiet_hours_end`. The hour is only how long the runner waits before looking again, in case
the journey was fixed. A past `active_until` still skips first.

**Workspace quiet hours are one range, saved as a pair.** `workspace.quiet_hours_start`
and `workspace.quiet_hours_end` are both set (24-hour `HH:MM`, different) or both
blank. Saving enforces it on every path: the Quiet hours control on Settings and the
`put_quiet_hours {start, end}` op (owner only) write both in one transaction, and
`put_setting` on a single quiet-hours key is refused (400, naming both keys) if it would
leave one end unset or the two equal. **To turn workspace quiet hours off, clear the pair:**
press Clear on the Quiet hours control (or empty both fields and Save), or call
`put_quiet_hours {"start": "", "end": ""}` (owner only; both keys must be present, so a
call with the arguments forgotten is a 400, not a silent clear). Clearing deletes both settings
rows in one transaction, so they read back as unset (Settings shows "Not set", and sends are
no longer held by workspace quiet hours); each cleared key is audited old value to null.
Clearing exactly one end is still refused. Clearing is also the way out of a stored
half-set or invalid pair. Pre-existing data that breaks the rule (half-set,
equal, or not `HH:MM`) is not guessed at: while a journey has no quiet hours of its
own, every send for it holds with `reason: "invalid workspace quiet hours"` until the
pair is fixed on Settings, where the Quiet hours row shows "Incomplete" or "Not valid" with the reason instead of "Not set". A journey that sets its own `quiet_hours` never reads the
workspace pair.

`sendAllowed` returns `{ allow: true }`, a hold `{ allow: false, until, reason }`
(`before launch`, `quiet hours`, `send window`), the invalid holds above, or
`{ allow: false, until: null, reason: "past active-until" }` which skips the send.

When several controls hold, `until` is the first instant at which all of them
allow the send (it walks forward until nothing holds), one minute past the last
boundary, and always after `now`; `reason` names the control that sets it. If that
instant would be at or after `active_until`, the answer is the skip at once.
A boundary that falls in a spring-forward gap (a local time that does not exist, such
as 02:30 on the US change day) resolves to the first instant after the gap; an
ambiguous autumn time resolves to its first occurrence.

## Not in 3.1 (left for later rows)

- Node kinds beyond wait/exit/note/branch/goal/goto/ab_split: actions (3.8), send (3.9).
- A delayed trigger (3.3) is a trigger kind, not a node; see "Delayed triggers" below. It writes `lp.trigger_fires` with `cancel_on`; enrolment copies that list onto `run.context.cancel_on`.
- Journey-level approval UI (the builder, 3.13). The approval gate itself is in place now.
- A journeys page and the builder (3.13). There is no UI in 3.1.

## Delayed triggers (3.3)

A `delayed` trigger fires N days after event X unless event Y happens first:
`config = {after_event: X, days: 1..365, unless_event: Y}` (or `unless_events: [Y1, Y2]`).
Y must differ from X; a config where X also cancels itself is rejected.

- X arms a row in `lp.trigger_delays` (`status` pending | fired | cancelled). The
  `trigger_scan` job fires the due ones, writing one `lp.trigger_fires` row
  (`dedupe_key = delay:<id>`, payload `{delay_id, cancel_on}`).
- **Timing windows use `occurred_at`, never `recorded_at`.** `source_at` is X's
  `occurred_at`; `due_at = source_at + N days`. A backfilled X starts its clock when
  it happened, so it can be due the moment it is stored. Y cancels only if its
  `occurred_at` is in `[source_at, due_at]`: a Y from before X, or one that
  happened after the delay was already owed, does not cancel it. This holds
  at emit time and in the scan, so a late-recorded Y or a backlog never cancels an owed fire.
- **Identity.** A delay armed for a contact is answered only by a Y for that same
  contact (not by a company-level Y, not by another contact at the company). A
  company-level delay (X had no contact) is answered by any Y at that company.
- Order. In one batch of events, each event is handled in order: arm any delay it
  starts, then cancel any pending delay it answers. At emit time only rows not yet
  due are cancelled; a past-due row is decided by the scan with the full window check.
- **Disabled triggers.** Disabling a delayed trigger cancels its pending delays in the
  same statement: a database trigger on `lp.triggers` (`enabled` true -> false) marks
  them `cancelled`, so every write path (`set_trigger_enabled`, `upsert_trigger` with
  `enabled: false`, raw SQL) is covered and disable-then-re-enable between two scans
  cannot keep them. The scan repeats the sweep as a backstop and never fires a
  disabled trigger's row. Re-enabling does not bring cancelled delays back; a new X
  arms a new delay. A fire the delayed trigger had already written before it was disabled
  is not enrolled either: the runner skips fires of disabled triggers (see above). The
  two guards are complementary.
- Concurrency. The scan locks the due rows (`FOR UPDATE ... SKIP LOCKED`) inside one
  transaction, so overlapping scans never take the same row; the unique
  `dedupe_key` on the fire is the second guard.
- Migration 0069 replaces the `triggers_kind_check` constraint from 0053 (the name
  Postgres gives that inline column check). The drop is `if exists`, the add is not
  guarded: it fails loudly if a stored kind is outside the list.
