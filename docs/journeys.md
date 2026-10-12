# Journeys: model, versions and the runner (plan 3.1)

A journey moves leads through a graph of steps: wait, then do something, then
branch, and so on. This file is the contract the other Phase 3 rows build on
(3.3 delayed triggers, 3.4 waits, 3.5 branches, 3.7 goals and exits, 3.8
actions, 3.9 sends, 3.12 frequency caps). Nothing in 3.1 sends email.

## Tables (`db/migrations/0057_journeys.sql`)

- `lp.journeys` — id, name, `status` (draft | testing | live | paused | sunset),
  `campaign_id`, `trigger_id` (a 3.2 trigger that enrols leads), `trigger_cursor`
  (last `lp.trigger_fires.id` consumed), `entry_mode` (once | multiple),
  `goal` jsonb (3.7 fills it), `settings` jsonb, `current_version`.
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

Built-in kinds (`lib/journeys/nodes.ts`): `wait` (below), `exit` ({reason};
ends as `exited`), and `note` (does nothing; moves on). `branch` above is an
example of a kind 3.5 adds.

### `wait` (3.4)

Config, all optional but at least one of a duration or `until`:

- `minutes`, `hours`, `days` — a duration measured from `node_entered_at`
  (at most 366 days).
- `until` — an absolute ISO date-time (a slot). When set it wins over the duration.
- `drop_if_replied` (boolean) — exit the run if a `reply_received` event lands.
- `drop_if` (an event type or a list of them, e.g. `["review.posted"]`) — exit the
  run if any of these lands. Each entry must match the event type key shape
  (`^[a-z][a-z0-9_.]{0,63}$`, dots allowed, same as `lp.event_types.key`);
  publish rejects a bad entry, it never filters one out.
- The run's `context.cancel_on` (a list of event types, e.g. set by a 3.3
  delayed trigger) is honoured the same way.

A dropped run ends as `exited` with `result.dropped` set to the event type.
`validate` and publish never change the node's config; `drop_if_replied` adds
`reply_received` to a copy of the list at run time only, so switching it off in
a later version stops dropping on replies.

Drop window: a drop looks for an event of that type for this lead (company or
contact) whose `occurred_at` is at or after the run's journey entry time
(`run.entered_at`), not the time it reached the wait node. So "drop if they
replied at any point since entering the journey": a reply that arrives after
entry but before the wait node still drops them, and nobody who replied gets
mailed. The window uses `occurred_at`, not `recorded_at`, so an event backfilled
by a reconcile is placed when it actually happened: an old reply that predates
entry does not drop the run, one that happened after entry does.

While any drop is configured the wait rechecks at least every minute (it does
not sleep to the end), so a reply is seen within about a minute. At run time an
event type that is not in `lp.event_types` (or a malformed `context.cancel_on`
entry) fails that node with a clear error instead of silently never matching (the runner retries it after 1 then 5 minutes and marks the run `error` on the third failure, like any failing node; the wait itself reads only and has no side effect to repeat);
publish can only check the key's format, since validation has no database access.

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
  that checks `lp.lead_events` since `run.entered_at` (by `occurred_at`) and returns
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

- pass `ctx.idempotencyKey` (`journey-run:<run_id>:<node_id>:<time the run reached the node>`)
  to the outside service as its idempotency key. It is the same on every retry of
  one visit, and new when a loop brings the run back to the node;
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
  — inside a transaction. Honours `entry_mode` and the one-open-run rule.
- `exitRuns(db, actor, { run_id } | { journey_id, company_id | contact_id })`.
- `advanceRun(db, runId, now)` — locks the run with `FOR UPDATE SKIP LOCKED`,
  so two ticks never move the same run. Each node is its own transaction.
- `runDueJourneys(db, { budgetMs? })` — one tick: enrol from new trigger fires of
  live journeys (a new journey starts from the newest fire, it does not replay old
  ones), then advance due runs of live, testing and sunset journeys, oldest due
  first. A tick stops taking new runs after `TICK_BUDGET_MS` (90 s; the job times
  out at 120 s). Each run commits on its own, so the rest wait for the next tick,
  and the result says `deadline_reached: true`.
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

## Not in 3.1 (left for later rows)

- Node kinds beyond wait/exit/note: branch (3.5), split (3.6), goal and go-to (3.7), actions (3.8), send (3.9).
- Journey-level approval UI (the builder, 3.13). The approval gate itself is in place now.
- A journeys page and the builder (3.13). There is no UI in 3.1.
