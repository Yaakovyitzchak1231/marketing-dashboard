# Agents API: how an agent works with the dashboard

Every agent (Tab, Hermes, Claude Code, Manus, n8n, anything) works in the same database as the
people, as itself. One contract, several doors; pick what fits the agent.

## 1. Identity: an API key per agent

`/agents` → *Add an agent* (id, name). On its page → **API keys** → *Create a key* (shown once,
stored hashed; revoke any time). Every request sends `Authorization: Bearer <key>`.
(`OPS_AGENT_TOKENS` in Vercel still works for existing agents.) A paused agent gets `423`.

## 2. Hearing about work instantly: delivery channels

Everything that concerns an agent (a task assigned or handed to it, an @mention, a direct message,
an approval answer) is a **notification**. Each one is delivered right away on every channel the
agent has, and each delivery has a status the people can see on the task:
`sent → delivered → read`, or `held` (quiet hours), `failed` (with the reason), `not connected`.

Choose channels on the agent's page → **How they hear about new work**:

| Channel | For | What happens |
|---|---|---|
| webhook | agents with a public HTTPS endpoint | `POST <url>` with the event JSON (below). Headers: `X-Dashboard-Event: notification.<kind>`, `X-Dashboard-Delivery: <id>`, `X-Dashboard-Timestamp: <unix s>`, `X-Dashboard-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>`. Any 2xx = delivered. 5xx / 429 / timeout retried (10 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h); other 4xx = failed. Reject timestamps older than 5 min. |
| ntfy (wake-up ping) | agents with no public address (Hermes on a firewalled server) | `POST https://ntfy.sh/<private topic>` with `{"d": <delivery_id>}` only. The agent keeps an outbound subscription (`GET https://ntfy.sh/<topic>/json`) and, on a ping, reads its feed. Re-pinged every 5 min until acked. |
| email | agents whose door is a mailbox (Tab) | Mail with the summary, task link, how to act, and the event JSON. Needs `MAIL_PROVIDER` (`resend` or `brevo`), `MAIL_API_KEY`, `MAIL_FROM` in Vercel. |
| stream | agents that can hold a connection | `GET /api/ops/stream` (Server-Sent Events): `event: notification`, `id: <delivery_id>`, `data: <event JSON>`. Closes after ~50 s with `retry: 1000`; reconnect. Keeps servers awake, so prefer ntfy/webhook for 24/7 agents. |
| pull | agents that can only poll | `GET /api/ops/feed?limit=50` → events not yet acked. |
| mcp | MCP clients (Claude Code, Claude Desktop, Hermes) | `https://<dashboard>/api/ops/mcp` (Streamable HTTP) with the bearer header; call `get_events`. |
| relay (people) | a person's phone | Another agent carries it: e.g. Hermes sends Yaakov a WhatsApp. Shows up in that agent's feed with a `relay` object. Held during Shabbos when the person has quiet hours on (default). |

### The event (same everywhere)
```json
{
  "type": "notification",
  "delivery_id": 123, "notification_id": 45,
  "kind": "assigned | handoff | mention | message | approval | task_update",
  "recipient": "hermes", "recipient_name": "Hermes",
  "from": "owner", "from_name": "Yaakov", "from_kind": "human",
  "summary": "Yaakov assigned you \"Find 100 jewelers\"",
  "body": "full text of a direct message, else null",
  "task": { "id": 1, "title": "...", "kind": "find_leads", "status": "queued", "url": "https://.../team/1" },
  "comment_id": null,
  "created_at": "2026-10-09T13:44:00.000Z",
  "relay": null,
  "ack": { "method": "POST", "url": "https://.../api/ops/feed/ack", "body": { "ids": [123] } }
}
```
`relay` (only on items an agent carries for a person): `{ "target": "whatsapp", "to": null, "text": "..." }`.

### Acknowledge
`POST /api/ops/feed/ack {"ids":[123]}` → delivered. Unacked feed items are offered again after 2 min,
so handling must be idempotent per `delivery_id`. (Webhook 2xx counts as delivered by itself.)

## 3. Doing the work (REST, `POST /api/ops {op, ...}` or the aliases)

| What | op | REST alias |
|---|---|---|
| my events | `feed {after_id?, limit?}` | `GET /api/ops/feed` |
| ack | `feed_ack {ids}` | `POST /api/ops/feed/ack` |
| take a task | `claim_task {task_id? \| kinds?, lease_seconds?}` | `POST /api/ops/tasks/claim` |
| keep it / progress | `heartbeat {task_id, progress?, lease_seconds?}` | `POST /api/ops/tasks/:id/heartbeat` |
| note on the thread | `comment {task_id, body}` (`@owner`, `@tab` mention) | `POST /api/ops/tasks/:id/comment` |
| finish | `complete_task {task_id, report, result?}` | `POST /api/ops/tasks/:id/complete` |
| give up | `fail_task {task_id, error, retry?}` | `POST /api/ops/tasks/:id/fail` |
| pass it on | `handoff_task {task_id, to, note}` | `POST /api/ops/tasks/:id/handoff` |
| direct message | `send_message {to, body, task_id?}` | `POST /api/ops/messages` |
| what am I doing | `presence {status_note}` | `POST /api/ops/presence` |

`GET /api/ops` lists every op and its arguments. Anything outward or paid goes through
`request_approval` (a person decides); Instantly changes only through the `instantly_*` ops.

## 4. MCP

Server: `https://<dashboard>/api/ops/mcp`, header `Authorization: Bearer <agent key>`.
Tools: `whoami`, `get_events`, `ack_events`, `list_my_tasks`, `get_task`, `claim_task`, `post_update`,
`complete_task`, `fail_task`, `handoff_task`, `send_message`, `track_event`.

Claude Code: `claude mcp add --transport http dashboard https://<dashboard>/api/ops/mcp --header "Authorization: Bearer <key>"`.
Hermes (`config.yaml`): `mcp_servers.dashboard: {url: https://<dashboard>/api/ops/mcp, headers: {Authorization: "Bearer <key>"}, enabled: true}`
(picked up within ~1 min, no restart). MCP gives an agent the tools; to be *woken* it still needs a
channel above (MCP servers cannot start a run in the client).

## 5. Hermes

Hermes uses the relay in `ops/hermes-relay/` (ntfy ping → feed → Hermes' Runs API on 127.0.0.1 →
results back). See its README for install and undo.

## 6. Tab

Tab's channel is email to its mailbox (seeded by migration 0013); a new mail wakes Tab within seconds,
and Tab works the task through this API with its own key.


## 7. Tools hub (lib/integrations/ops.ts)

The tools Yaakov runs next to the dashboard (Warmbly, Listmonk, Miniflux,
changedetection.io, Umami on his OVH server; the build tracker sheet and the
plan doc) are rows in `lp.integrations`, never hard-coded links. The OVH
background runner (`docs/RUNNER-integrations.md`) polls each tool's own API
and writes health + numbers here; the dashboard never calls a tool directly.

| op | args | notes |
|---|---|---|
| `list_integrations` | `{active_only?}` | every tool/link row, sorted |
| `get_integration` | `{id}` | one row |
| `put_integration` | `{id, name, kind, description?, url?, api_url?, reachable_from?, settings_prefix?, visibility?, sort?, active?}` | owner only |
| `report_integration_health` | `{id, status (ok\|degraded\|down\|unknown), detail?}` | the runner (`system`) or owner |
| `put_integration_snapshots` | `{id, snapshots: [{metric, value, dims?, data?, campaign_id?}], job_run_id?}` | batch; the runner (`system`) or owner; `value: null` means the tool didn't say |
| `latest_integration_metrics` | `{id?, campaign_id?}` | the latest snapshot per (integration, metric, campaign) |
| `campaign_for_newsletter_list` | `{list}` | `{campaign_id}` via `lp.campaign_profiles.newsletter_list`, or `{campaign_id: null}` |
| `campaign_for_utm_campaign` | `{utm_campaign}` | `{campaign_id}` via `lp.campaign_profiles.utm.campaign`, or `{campaign_id: null}` |

The dashboard shows this at `/tools`: a card per active tool (link, health,
latest numbers, optionally filtered to one campaign), docs/sheets as plain
link cards.
## 7. Background jobs (the runner on Yaakov's OVH server)

`lp.jobs` is the schedule; `lp.job_runs` is the log. A small runner service (not deployed yet — see
`docs/RUNNER.md`) polls the ops API as its own agent, `system`, and runs each due job's handler.

| What | op | Who |
|---|---|---|
| list jobs | `list_jobs {campaign_id?, kind?, enabled?}` | anyone |
| one job | `get_job {name}` | anyone |
| create/update a job | `put_job {name, kind, description?, schedule_cron?, timezone?, campaign_id?, payload?, enabled?, timeout_s?}` | owner or `system` |
| enable/disable | `set_job_enabled {name, enabled}` | owner or `system` |
| run once, now | `run_job_now {name}` | owner or `system` |
| claim due work | `claim_jobs {runner, limit?}` | `system` only |
| report how a run ended | `finish_job_run {run_id, status: ok\|failed\|skipped\|timeout, output?, error?}` | `system` only |
| mark stuck runs | `reap_stale_jobs {}` | owner or `system` |
| run history | `job_runs {name?, limit?}` | anyone |

`schedule_cron` is a standard 5-field cron expression (minute hour day-of-month month day-of-week);
`timezone` is any IANA name (default `America/New_York`); `next_run_at` is computed from cron on every
save, enable, and finish. A job with no `schedule_cron` only ever runs via `run_job_now`.

Job kinds are handler files in `runner/handlers/` on the runner box, auto-registered by filename —
`heartbeat`, `http_ping` (payload `{url}`), and `ops_call` (payload `{op, args}` — runs any other ops
API op on a schedule; this is how a per-campaign monitor or a tools-hub poller is expected to run,
without its own handler file).
## 7. Lead events: tracking what happens to a lead

`lp.lead_events` is the structured stream every lead's timeline reads from — one append-only row per
thing that happened: an email sent or opened, a reply, a tag added, a verification result, a custom
event from an agent. It's separate from `lp.events` (the human-readable activity feed) and from
`lp.campaign_touches` (the raw Instantly webhook record, kept as-is); the Instantly webhook writes
to both `campaign_touches` and `lead_events` in the same transaction.

A type must already be registered in `lp.event_types` before an event can use it — `register_event_type`
adds one without a deploy. 21 types ship seeded (email_sent, email_opened, email_link_clicked,
reply_received, auto_reply_received, email_bounced, lead_unsubscribed, lead_interested,
lead_not_interested, meeting_booked, campaign_completed, stage_changed, status_changed, field_changed,
tag_added, tag_removed, added_to_campaign, pushed_to_instantly, suppressed, verified, custom) —
`list_event_types` lists what's active now. `stage_changed` and `status_changed` are written by a
database trigger off `lp.status_history`, so don't emit those yourself from a writer that already
changes a company's stage or a contact's status; everything else is emitted by hand at the point of
the write (`lib/events/emit.ts`'s `emitLeadEvent` / `emitLeadEvents`, used inside a transaction).

| op | args | what |
|---|---|---|
| `track_event` | `{type, company_id? \| contact_id? \| email, props?, occurred_at?, dedupe_key?, campaign_id?, instantly_campaign_id?, step?, source?}` | Record one event. Give company_id, contact_id or email (email resolves to a contact/company when one matches). Unknown type -> 400; a repeated dedupe_key -> `{inserted:false}`, not an error. |
| `track_events` | `{events: [...]}` (same shape, at most 500) | One multi-row insert. Returns one `{ok, ...}` result per item, same order — a bad item (unknown type, missing identity) fails only that item, not the batch. |
| `recent_lead_events` | `{company_id? \| contact_id? \| campaign_id?, type?, since?, limit?}` | A lead's (or a campaign's) timeline, newest first. At least one filter is required. |
| `list_event_types` | `{category?, active_only?}` | The event type registry (for building a UI or picking a type before `track_event`). |
| `register_event_type` | `{key, label, category, props_schema?}` | Add a new type (slug key, e.g. `review_posted`). Any authenticated actor may register one; it only opens the door for `track_event` to use the key — it never emits an event on its own. |

A `track_event` worth sending from an agent: a custom milestone (`type: 'custom', props: {instantly_type: '...'}` isn't
needed outside the Instantly webhook — for your own events, `register_event_type` a real key first,
e.g. `review_posted`, `form_submitted`, `website_visited`), or a signal you detected (a price page
changed, a job posting went up) once Phase "Prospecting & signals" lands.
## 7. Campaign profiles

Every campaign gets a profile (industry, ICP, keywords, competitors, feeds,
directories, signal rules, fingerprints, UTM, KPIs) — see `docs/campaign-profiles.md`
for the full shape and the "how it works for any new campaign" walkthrough. Agents
reach it through the same ops door as everything else (`POST /api/ops {op, ...}`).

| op | args |
|---|---|
| `get_campaign_profile` | `{campaign_id}` → `{profile, items (grouped by kind), exists}`. Creates nothing on read. |
| `update_campaign_profile` | `{campaign_id, industry?, vertical?, description?, icp?, value_prop?, newsletter_list?, utm?, kpis?, setup_status?}` |
| `add_profile_items` | `{campaign_id, items: [{kind, name, value?, config?, status?, source?, rationale?, sort?}]}` — kinds: `keyword, topic, competitor, feed, forum, directory, trade_show, signal_rule, fingerprint, social_channel, negative_keyword, search_phrase, place_category`. Deduped case-insensitively per (campaign, kind, name). |
| `set_profile_item_status` | `{ids: [...], status: suggested\|approved\|rejected\|archived}` |
| `update_profile_item` | `{id, name?, value?, config?, rationale?, sort?}` |
| `suggest_campaign_profile` | `{campaign_id, industry, notes?, example_sites?}` — AI-assisted setup; saves everything as `status:'suggested', source:'ai'`, **never auto-approved**; every suggestion with an HTTP-checkable value is verified before it's returned. `{configured:false, reason}` when no free/OSS AI provider is set up. |
| `copy_campaign_profile` | `{from, to}` — copies the profile's scalars and items (new items get `source:'copied'`); skips anything the destination already has. |
| `list_profile_items` | `{kind, status? (default approved), campaign_id?}` — **the op a monitor/connector agent calls**: pass `campaign_id` for one campaign's approved items of a kind, or omit it to get every active campaign's approved items of that kind in one call. |
| `list_pools` / `create_pool` / `update_pool` | Pools (the industries/audiences a campaign's `pool` can be) are their own ops in `lib/pools/ops.ts` (PR 1.18); the wizard uses the same module. |
| `recheck_profile_item` | `{id}` — re-run verification on one item (a feed re-parsed, a page re-fetched, robots.txt re-read) and save the result. |

## 8. Segments: the condition engine (plan 2.1)

`lp.segments` (migration 0024) is one definition compiled to one parameterized SQL
query (`lib/segments/compile.ts`) -- no segment's match is ever string-built from a
value, only from the field registry's own identifiers (`lib/segments/fields.ts`), so
a value with SQL-looking characters in it just becomes a literal value, never a
clause. A segment is `dynamic` (membership = whatever the definition matches, right
now) or `static` (a hand-picked list in `lp.segment_members`, plan 2.4's backend).
`campaign_id` null means "all campaigns"; set, the segment is scoped to one.

**Definition shape** (`lib/segments/definition.ts`, `validateDefinition` rejects
anything else with a plain error):
```
{
  "entity": "company" | "contact",
  "include": [ { "conditions": [ <condition>, ... ] }, ... ],   // OR across groups, AND within a group
  "exclude": [ { "conditions": [ <condition>, ... ] }, ... ]    // a record matching ANY exclude group is dropped
}
```
`include: []` means "match everyone" (useful for an exclude-only segment, e.g.
"everyone except suppressed"). A condition is one of:

- `{"kind":"field","field":"company.state","op":"in","value":["NY","NJ"]}` -- a field
  from the registry (`company.*` / `contact.*`; `list_fields` below) with an operator
  for its type: text/array get `is, is_not, contains, not_contains, in, not_in, exists,
  not_exists`; number adds `gt, gte, lt, lte, between`; date adds `before, after,
  within_last_days, more_than_days_ago, between`; boolean is `is, is_not, exists,
  not_exists`.
- `{"kind":"event","event_type":"reply_received","count_op":"eq","count":0,"within_last_days":30}`
  -- a count of `lp.lead_events` of one type in a window, compared with `eq/gt/gte/lt/lte`.
  `"prop":{"path":"props.url","op":"contains","value":"/pricing"}` filters on one
  top-level key of the event's `props` jsonb.
- `{"kind":"relative_date","field":"contact.verified_at","op":"after","days":7,"compare_to":"company.created_at"}`
  -- one date field vs another date field (or `"now"`, the default), offset by N days.
- `{"kind":"in_segment","segment_id":12}` / `{"kind":"not_in_segment","segment_id":12}`
  -- membership in another segment of the SAME entity. Nesting is checked for cycles
  and capped at 3 levels deep.
- `{"kind":"campaign_membership","mode":"in_campaign","campaign_id":5}` (or
  `"any_active_campaign"` / `"never_contacted"`, no `campaign_id` needed).
- `{"kind":"quality","op":"suppressed" | "not_suppressed" | "verified_sendable" | "not_verified_sendable"}`
  -- "sendable" = verified email, not suppressed, not unsubscribed, not do-not-contact.

Geography is `company.state` / `company.city` (plain field conditions) only --
`lp.companies` has no lat/lng yet, so radius search is deferred until it does.
Custom fields (1.7), scores (2.8) and computed traits (2.7) plug into the SAME
compiler with no changes there: call `registerField` (`lib/segments/fields.ts`) with
a `sql` expression reading the new column (e.g. `"c.custom ->> 'ring_brand'"`) and the
key shows up in `list_fields` and works in every condition kind above.

**Three examples**, with their readback (`lib/segments/readback.ts`):
1. `{"entity":"company","include":[{"conditions":[{"kind":"field","field":"company.state","op":"in","value":["NY","NJ"]},{"kind":"quality","op":"verified_sendable"},{"kind":"event","event_type":"reply_received","count_op":"eq","count":0,"within_last_days":30}]}],"exclude":[{"conditions":[{"kind":"campaign_membership","mode":"any_active_campaign"}]}]}`
   → "Leads where State is NY or NJ and verified email, sendable and "reply_received" exactly 0 times in the last 30 days, excluding in an active campaign."
2. `{"entity":"contact","include":[{"conditions":[{"kind":"event","event_type":"email_opened","count_op":"gte","count":3,"within_last_days":14}]}]}`
   → "Contacts where "email_opened" at least 3 times in the last 14 days."
3. `{"entity":"company","include":[{"conditions":[{"kind":"in_segment","segment_id":3}]}],"exclude":[{"conditions":[{"kind":"quality","op":"suppressed"}]}]}`
   → "Leads where in segment #3, excluding suppressed."

| op | args | what |
|---|---|---|
| `list_fields` | `{}` | every registered field (key, label, table, type, operators) -- read-only, for building a picker |
| `list_segments` | `{include_archived?, campaign_id?}` | every live segment (or scoped to one campaign, plus un-scoped ones) |
| `get_segment` | `{id}` | one segment, with its readback |
| `create_segment` | `{name, entity, definition, description?, kind? ('dynamic' default), campaign_id?}` | validates the definition before writing; `definition.entity` must match `entity` |
| `update_segment` | `{id, name?, description?, campaign_id?, definition?}` | entity cannot change after creation |
| `archive_segment` | `{id}` | soft delete (`archived_at`); idempotent |
| `segment_preview` | `{definition}` or `{entity, include?, exclude?}` | compiles a definition that need not be saved yet -> `{entity, counts: {companies, contacts, verified_sendable}, sample (10 rows), readback}` |
| `segment_members` | `{id, limit?, offset?}` | static: the stored rows; dynamic: the live compiled match |
| `segment_add_members` | `{id, company_ids? \| contact_ids?}` | static segments only; emits `segment_joined` lead events |
| `segment_remove_members` | `{id, company_ids? \| contact_ids?}` | static segments only; emits `segment_left` lead events |
| `segment_snapshot` | `{}` | writes one `lp.segment_snapshots` row per live segment (companies/contacts/verified-sendable counts) -- the op the runner's nightly job (1.10) calls for 2.12's size-over-time |

Deferred from this slice (left for the builder UI / later plan items, not started
here): the builder UI itself (2.2), saved presets (2.3), the leads-filter drawer
(2.5), using a segment as a campaign source (2.6), computed traits and scoring as
field-registry entries (2.7/2.8 -- the registry is ready for them), the "describe a
segment" AI box (2.11), and the analytics UI on top of `segment_snapshot` (2.12).


## Computed traits (2.7) and segment analytics (2.12) — P2-I

Traits are per-lead numbers computed once from `lp.lead_events` and reused everywhere:
in a segment condition (`trait.<key>`, registered into the SAME field registry
`segment_preview`/`create_segment` already read -- no new condition kind), on a score
rule, on the lead profile. Five campaign-agnostic traits ship seeded (migration 0033):
`replies_30d`, `opens_14d`, `days_since_last_touch`, `steps_received`, `total_meetings`.

A trait definition: `{"event_types":["reply_received"],"aggregation":"count"|"sum"|
"min"|"max"|"last"|"days_since","prop":"minutes","window_days":30,"prop_filters":
[{"path":"url","op":"is"|"contains","value":"..."}]}`. `prop` is required for
sum/min/max/last (the jsonb prop key to read off each event, cast numeric); `count`
and `days_since` ignore it. `window_days` omitted/null = all time. `days_since` and
sum/min/max/last come back `null` (never 0) for an entity the event has never
happened to -- NULL is not 0 is the house rule here too.

| op | args | what |
|---|---|---|
| `list_traits` | `{include_archived?}` | every trait |
| `get_trait` | `{key}` | one trait |
| `define_trait` | `{key, label, entity, definition}` | create, or redefine an existing key's rules (upsert); resets `last_computed_at` so the next recompute is a full one under the new rules |
| `archive_trait` | `{key}` | soft delete; also drops its segment field (an already-saved condition naming it just stops matching) |
| `recompute_traits` | `{key?, full?}` | recomputes one trait or every active one; incremental (only entities with a new `lp.lead_events` row since the last run) unless `full: true` |
| `trait_preview` | `{entity, definition, sample_size?}` | values this (not-necessarily-saved) definition produces for up to 20 (default 5) sample leads -- writes nothing |

The `traits_refresh` runner job (hourly) calls `recompute_traits` with no args
(every active trait, incremental). Defining or redefining a trait through `define_trait`
makes it usable in a segment condition immediately, before the next job run.

Segment analytics (2.12) extend `segment_snapshot` (already in this doc, P2-A): a
segment with `alert_rule` set (`{"enabled":true,"shrink_pct":20,"grow_pct":50}`, a
plain column on `lp.segments`) gets checked against its two most recent daily
snapshots right after they're written, and a crossing writes one ordinary
notification to `owner` (`kind: 'segment_alert'`) -- at most once per day's snapshot,
never a repeat for a crossing that persists.

| op | args | what |
|---|---|---|
| `segment_stats` | `{id, days?}` | `{history: [{taken_on, companies, contacts, sendable}, ...], metrics: {sample_size, sample_capped, reply_rate, meetings, avg_score, avg_score_field}}` -- `avg_score`/`avg_score_field` are `null` when no score field is registered yet (lead scoring, 2.8, is a sibling PR; this never invents a number) |

UI: `app/segments/traits/page.tsx` (list, define, archive, preview-on-5-leads) and
`app/segments/[id]/stats/page.tsx` (sparkline + the metrics card,
`components/segments/SegmentStats.tsx` + `SizeSparkline.tsx` -- a self-contained
component another screen can drop in directly).

Deferred from this slice: the alert UI (configuring `alert_rule` is DB/ops-only for
now, no form yet); a `score.*` field to read for `avg_score` (2.8's own PR).

<!-- retrigger: Vercel git_info_fail on first branch deploy -->
