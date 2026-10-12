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
measured from `node_entered_at`), `exit` ({reason}; ends as `exited`),
`note` (does nothing; moves on), and `branch` (3.5, below).

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

## Not in 3.1 (left for later rows)

- Node kinds beyond wait/exit/note/branch: split (3.6), goal and go-to (3.7), actions (3.8), send (3.9).
- Human approval before a send-capable journey goes live (lands with 3.9, when a send kind exists).
- A journeys page and the builder (3.13). There is no UI in 3.1.
