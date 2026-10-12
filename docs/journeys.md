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

Built-in kinds (`lib/journeys/nodes.ts`): `wait` ({minutes, hours, days},
measured from `node_entered_at`), `exit` ({reason}; ends as `exited`), and
`note` (does nothing; moves on). `branch` above is an example of a kind 3.5 adds.

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
list). A handler that throws marks that run `error` with the message; other
runs carry on. One advance takes at most 50 steps, then resumes next tick.

## The runner (`lib/journeys/runner.ts`)

- `enrollLead(q, actor, journeyId, { company_id?, contact_id?, source, context, trigger_fire_id })`
  — inside a transaction. Honours `entry_mode` and the one-open-run rule.
- `exitRuns(db, actor, { run_id } | { journey_id, company_id | contact_id })`.
- `advanceRun(db, runId, now)` — locks the run with `FOR UPDATE SKIP LOCKED`,
  so two ticks never move the same run.
- `runDueJourneys(db)` — one tick: enrol from new trigger fires of live
  journeys (a new journey starts from the newest fire, it does not replay old
  ones), then advance every due run of live, testing and sunset journeys.

## Ops (agents: `POST /api/ops {op, ...}`)

| op | args | who |
| --- | --- | --- |
| `journey_list` | {campaign_id?, status?} | Viewer+ |
| `journey_get` | {journey_id, version?} | Viewer+ |
| `journey_runs` | {journey_id?, company_id?, contact_id?, status?, limit?} | Viewer+ |
| `journey_run_log` | {run_id} | Viewer+ |
| `journey_validate` | {graph} | Viewer+ |
| `journey_upsert` | {id?, name, campaign_id?, trigger_id?, entry_mode?, goal?, settings?} | Editor+ |
| `journey_publish` | {journey_id, graph, note?} | Editor+ |
| `journey_set_status` | {journey_id, status} | Editor+ |
| `journey_enroll` | {journey_id, company_id? / contact_id? / company_ids? / segment_id?, offset?, context?} | Editor+ |
| `journey_exit` | {run_id} or {journey_id, company_id? / contact_id?}, reason? | Editor+ |
| `run_journeys` | {limit?} | Owner or the runner (`system`) |

Roles apply to keys minted for a person (`lib/ops/actor-role.ts`); agent keys
are not role-gated, as with every other op.

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
itself). The hour is only how long the runner waits before looking again, in case
the journey was fixed. A past `active_until` still skips first.

`sendAllowed` returns `{ allow: true }`, a hold `{ allow: false, until, reason }`
(`before launch`, `quiet hours`, `send window`), the invalid hold above, or
`{ allow: false, until: null, reason: "past active-until" }` which skips the send.

When several controls hold, `until` is the first instant at which all of them
allow the send (it walks forward until nothing holds), one minute past the last
boundary, and always after `now`; `reason` names the control that sets it. If that
instant would be at or after `active_until`, the answer is the skip at once.
A boundary that falls in a spring-forward gap (a local time that does not exist, such
as 02:30 on the US change day) resolves to the first instant after the gap; an
ambiguous autumn time resolves to its first occurrence.

## Not in 3.1 (left for later rows)

- Node kinds beyond wait/exit/note: branch (3.5), split (3.6), goal and go-to (3.7), actions (3.8), send (3.9).
- Human approval before a send-capable journey goes live (lands with 3.9, when a send kind exists).
- A journeys page and the builder (3.13). There is no UI in 3.1.
