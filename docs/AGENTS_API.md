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
| `update_event_type` | `{key, label?, category?, active?}` | Change a custom type's label/category or switch it off (`active:false` makes `track_event` refuse the key). The key never changes. Built-in types (`source` `instantly`/`system`) are refused (409); `register_event_type` on a built-in key is refused too. Editor or Owner for a person's key. Also on the dashboard at Settings → Data → Event types. Each change writes an `lp.events` row (`event_type.registered` / `event_type.updated`). |

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
| `validate_campaign_profile` | `{profile?, items?}` — check a portable document. Writes nothing. Unknown keys refused. A Viewer may call it. |
| `export_campaign_profile` | `{campaign_id}` → `{exists, profile, items}`. Non-archived items, no ids. Creates nothing. 404 if the campaign is missing. A Viewer may call it. |
| `import_campaign_profile` | `{campaign_id, profile?, items?}` — merge. Existing live items are left alone. Every new item is `source:'import'` (the caller's source is ignored). Editor or agent; a Viewer gets 403. |

People read the approved profile at `GET /api/campaigns/:id/profile` (`lib/campaigns/profile.ts` `profileFor`). `PATCH` updates the scalar fields and needs editor. `activeProfiles()` is the same read across every non-archived campaign whose profile `setup_status` is `active`. Competitors stay items of kind `competitor`; there is no separate registry table.


## Instantly reconcile & data sources health (P2-D, plan 1.6 + 1.11)

| op | args |
|---|---|
| `instantly_reconcile_run` | `{since_days?}` (default 14) — the runner (`system`) or the owner only. Pulls per-lead Instantly activity (`POST /leads/list` interest status, `GET /emails` latest replies) for every contact the webhook already knows about, and inserts any `lp.lead_events` the live webhook missed, idempotently (same dedupe-key story as the webhook). Returns `{contacts_checked, leads_fetched, threads_fetched, events_considered, events_inserted, events_skipped_duplicate, errors}`. Runs nightly as runner job `instantly_reconcile` (seeded by `0028_instantly_reconcile_job.sql`); see `lib/instantly/reconcile.ts`. |
| `sources_health` | `{}` → one row per data source feeding the platform (Instantly webhook, Instantly nightly reconcile, email verifiers, the find-leads engine, imports, exports, Search Console, the background runner's own heartbeat, plus every row in `lp.integrations`): `{id, label, last_event_at, count_24h, by_type_24h, error_count_24h, last_error, last_error_at}`. Every field a stored row doesn't answer comes back `null` ("No data yet" in the UI), never a guessed number. See `lib/sources/health.ts`; shown on `/tools` under "Data sources". |
## 8. Lead scoring (plan 2.8)

Rule-based point scores beside the AI fit tiers (`lib/rules/evaluate.ts` stays the Fit
*gate*). Two kinds of score model, one row per model in `lp.score_models`:
`engagement` (how much a lead has engaged — opens, clicks, replies, meetings) and
`fit` (how well a lead matches a campaign's own ICP/buying-signal rules). A model
with `campaign_id: null` is the workspace default used by every campaign without
its own; a Fit model's rules are built from the campaign's own
`lp.campaign_profiles`/`lp.campaign_profile_items` (`signal_rule` items), never
hard-coded to an industry (`lib/scoring/rules.ts#fitRulesFromProfile`,
`lib/scoring/engine.ts#fitModelForCampaign`). Points can expire
(`expires_after_days` on a rule); `recompute_scores` re-evaluates events, drops
expired points from the live sum, and is safe to call repeatedly (idempotent —
re-processing the same events never double-awards). Crossing a threshold (e.g.
"hot" ≥ 25) writes a `score_threshold_crossed` lead event exactly once per
crossing (deduped), so journeys can trigger on it later. A nightly job
(`score_refresh`, seeded in `lp.jobs`) calls `lib/scoring/engine.ts#recomputeAllScores`.

| op | args |
|---|---|
| `list_score_models` | `{campaign_id?, kind?: engagement\|fit, active_only?}` |
| `get_score_model` | `{id}` |
| `upsert_score_model` | **Owner or system only** (an agent or Editor key gets 403). `{id?, name, entity: company\|contact, kind: engagement\|fit, campaign_id?, rules: [{rule_key,label,event_type,points,expires_after_days?,props_match?}], thresholds?: [{key,label,min}], max_points?, active?}` — create (omit id) or edit (give id); writes one `lp.status_history` row (`entity_type: 'score_model'`). At most one default (campaign_id null) model per entity+kind, one per-campaign model per entity+kind+campaign. |
| `recompute_scores` | **Owner or system only** (the nightly `score_refresh` job runs it as system). `{model_id?, company_id?, contact_id?}` — omit everything to recompute every active model for every lead it covers (the nightly job's call). |
| `lead_scores` | `{company_id}` → every active model's current score + threshold for one lead, for the lead page / a leads-table column. |

`lib/scoring/fields.ts#scoreFieldDescriptors` is the hand-off point for the segment
condition engine (plan 2.1) to register score fields later — not wired in, so it
doesn't collide with `lib/segments`.

## 9. Tags as first-class (plan 2.9)

`lp.companies.tags` (text[], since 0011) stays the tag storage; `lp.tag_defs`
(0031_tags.sql) adds an optional colour + description per tag. Rename and merge
update every company row carrying the tag in one transaction, write one
`lp.status_history` row (`entity_type: 'tag'`, `entity_key` = the tag), and emit
`tag_added`/`tag_removed` lead events per affected lead (both event types already
existed since 0018_lead_events.sql).

| op | args |
|---|---|
| `list_tags` | `{}` → every tag with its live count (from `companies.tags`) and any styling. |
| `add_tag` / `remove_tag` | `{company_id, tag, colour?, description?}` / `{company_id, tag}` — one company, emits `tag_added`/`tag_removed`. |
| `rename_tag` | `{from, to}` — updates every company carrying `from`; audited; `tag_removed`+`tag_added` per affected lead. |
| `merge_tags` | `{tags: [...], into}` — updates every company carrying any listed tag; audited; events per affected lead. |
| `set_tag_style` | **Owner only** (agent keys too). `{tag, colour?: "#rrggbb", description?}` |
| `tag_trends` | `{weeks?}` → tag-added counts per week (default last 8 weeks), from `lp.lead_events`. |

UI: Settings → Scoring (`/settings/scoring`) and Settings → Data → Tags
(`/settings/tags`), linked from the main Settings page. Both pages render an
honest "Needs migration 00NN" empty state on a preview deploy, where migrations
0030/0031 haven't run yet.
## 8. Custom fields, and CSV import (plan 1.7 + 1.13)

Custom fields let Yaakov define his own fields on a company or a contact (store
size, a rating, a trade show, anything) without a code change. Values live in
`companies.custom` / `contacts.custom` (jsonb, keyed by the field's slug); a
field's key is unique per entity regardless of which campaign it is scoped to
(`campaign_id` only filters where the field is *shown*, not where its value lives).

| op | args |
|---|---|
| `list_fields` | `{entity?: company\|contact, campaign_id?, include_archived?}` |
| `define_field` | `{entity, key, label, type: text\|number\|date\|select\|multi_select\|url\|boolean, options? (select/multi_select), campaign_id? (null = every campaign), sort?}` |
| `update_field` | `{id, label?, options?, sort?, campaign_id?}` — type and key are permanent once created |
| `archive_field` | `{id}` |

A value is written through the normal `update_entity` op (see section on inline
edit), with field named `custom.<key>` — e.g. `update_entity {type: 'contact', id: 42, field: 'custom.store_size', value: 'large'}`.
It is validated against the field's type the same way every other field is, and
audited in `lp.status_history` (entity_type `company`/`contact`, field `custom.<key>`).
Defining, renaming, re-scoping or archiving a field is itself audited (entity_type
`field_def`). `lib/fields/registry.ts`'s `listFieldDefs` is the one function other
features (the segment engine, the lead-edit UI, the CSV importer) should read from.

CSV import (plan 1.13), with a dry-run preview:

| op | args |
|---|---|
| `import_csv` | `{csv: string, mapping: {csv_column: target_field}, pool?, campaign_id?, dry_run?}` |

`target_field` is one of `email, first_name, last_name, title, phone` (contact),
`company_name, website, company_phone, city, state` (company), or
`contact_custom.<key>` / `company_custom.<key>` for a defined custom field; any
other mapping value is ignored. `pool` sets a new company's `segment`;
`campaign_id` also enrolls each row's company in that campaign
(`lp.campaign_leads`). `dry_run: true` runs the whole import for real inside a
transaction and rolls it back, so the counts — `would_create`, `would_update`,
`skipped_duplicate` (same email/phone seen earlier in this file),
`skipped_suppressed` (on `lp.suppressions`), `invalid` (no email or phone, a bad
email/phone, or an unknown/invalid custom-field value) — are exactly what a real
run right now would do, and nothing is written. A per-row `reason` rides every
non-created/updated row. A contact needs an email **or** a phone, not both — the
same phone-only contacts CSV import creates are usable everywhere else on the
dashboard (call tasks, the lead page, exports).

The dashboard's own UI: `/leads/import` (map → preview → import) and an
"Add lead" button on `/leads` (one row through the same pipeline, so it gets the
same dedupe/suppression/validation); `/settings/fields` (Settings → Data → Fields)
to define, rename and archive fields.

## 8. Duplicate detection & merge, and data retention

**Merge** (`lib/merge/ops.ts`) finds likely-duplicate companies or contacts and
collapses one into the other. Candidates are recomputed live from
`lib/leads/normalize.ts` against the raw fields (not read off the stored,
already-unique-indexed columns), so near-duplicates that drifted from the
current normalizer still turn up. A merge moves every dependent row (contacts,
campaign touches, sources, enrichment, comments, tasks, verification results)
to the kept id, applies the human's field-by-field choices, soft-deletes the
loser (`merged_into`), and writes `lp.merge_log` + `lp.status_history`. A
merged row is excluded from every dedupe unique index and from normal lists.

| op | args | what |
|---|---|---|
| `merge_candidates` | `{entity: company\|contact, limit?}` | Likely-duplicate pairs: same recomputed website domain, phone, name+address key (companies) or email (contacts). |
| `merge` | `{entity: company\|contact, keep, merge, choices?: {field: "keep"\|"merge"\|value}}` | **Owner only.** Collapses `merge` into `keep`. Unlisted fields default to `keep`'s value (falling back to `merge`'s when `keep`'s is empty). Rejects a self-merge or an id that is already a merge loser. |

UI: `app/leads/duplicates` — a side-by-side compare per candidate pair, pick
which side's value wins per field, then Merge.

**Retention & "Forget this person"** (`lib/retention/ops.ts`): `lp.retention_policies`
says how long raw `lp.campaign_touches` rows are kept per `event_type` (null
`keep_days` = forever; opens/clicks default to 540 days, everything else to
forever). `forget_contact` wipes PII from a contact in place (the row and its
company membership survive as an anonymized tombstone), scrubs the PII copies
elsewhere (campaign-touch email, verification-result email, enrichment,
sources) and clears that contact's own edit history, then suppresses the
address by a **sha256 hash** — never the plaintext — so the Lead Master import
(and any future import) never recreates them.

| op | args | what |
|---|---|---|
| `list_retention_policies` | `{}` | Every category and its `keep_days`. |
| `set_retention_policy` | `{event_category, keep_days: number\|null}` | **Owner only.** `null` = forever. |
| `forget_contact` | `{contact_id, confirm}` | **Owner only.** `confirm` must be the contact's own (normalized) email, or `"forget"` when it has none — a typed confirmation, not a one-click delete. |
| `retention_preview` | `{}` | What a sweep would delete now, per category (`touches`, `timeline_events`), plus `timeline_impact` (event types, score models, traits and segments that read them) when timeline rows are past their window. Deletes nothing. |
| `retention_sweep` | `{confirm: true, include_timeline?: boolean}` | **Owner only.** Deletes `lp.campaign_touches` rows past their category's `keep_days`, and `lp.lead_events` rows too only with `include_timeline` (never by default). Without `confirm` nothing is deleted (409). Deletes in batches (each its own short transaction, one cutoff for the whole run). When timeline rows were deleted it resets the affected traits to a full recompute and queues the `score_refresh` and `traits_refresh` jobs (`recompute_queued`); score points already earned are kept. Settings → Data has the review-then-confirm button. |

UI: a lead's contact row has "Forget this person" (typed confirmation);
Settings → Data lists every category with an editable `keep_days` field and
the manual sweep button.
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
  from the registry (`company.*` / `contact.*`; `segment_fields` below) with an operator
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
key shows up in `segment_fields` and works in every condition kind above.

**Three examples**, with their readback (`lib/segments/readback.ts`):
1. `{"entity":"company","include":[{"conditions":[{"kind":"field","field":"company.state","op":"in","value":["NY","NJ"]},{"kind":"quality","op":"verified_sendable"},{"kind":"event","event_type":"reply_received","count_op":"eq","count":0,"within_last_days":30}]}],"exclude":[{"conditions":[{"kind":"campaign_membership","mode":"any_active_campaign"}]}]}`
   → "Leads where State is NY or NJ and verified email, sendable and "reply_received" exactly 0 times in the last 30 days, excluding in an active campaign."
2. `{"entity":"contact","include":[{"conditions":[{"kind":"event","event_type":"email_opened","count_op":"gte","count":3,"within_last_days":14}]}]}`
   → "Contacts where "email_opened" at least 3 times in the last 14 days."
3. `{"entity":"company","include":[{"conditions":[{"kind":"in_segment","segment_id":3}]}],"exclude":[{"conditions":[{"kind":"quality","op":"suppressed"}]}]}`
   → "Leads where in segment #3, excluding suppressed."

| op | args | what |
|---|---|---|
| `segment_fields` | `{}` | every registered field (key, label, table, type, operators) -- read-only, for building a picker |
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


## Full lead profile (plan 2.10)

One call returns the whole 360 view of a lead for an agent: everything
`lib/leads/detail.ts` already reads (contacts, sources, enrichment,
verification, campaign touches, status history, comments, tasks), plus
milestones, a reachability strip, segment/list membership, this lead's
campaigns, its suppression status, its attached file links, its score (when
plan 2.8's `lp.scores` is merged on this deploy), and an engagement benchmark
against its campaigns' averages -- every number straight from stored rows,
never invented.

Optional tables (`lp.segments`/`lp.segment_members`, `lp.scores`, `lp.files`)
are read defensively: on a deploy that hasn't run their migration yet, that
section of the response comes back `{available: false, needs_migration: "..."}`
instead of throwing.

| op | args | what |
|---|---|---|
| `lead_profile` | `{company_id}` | the whole profile in one call (shape below) |
| `lead_files_add` | `{company_id, name, url, contact_id?, note?}` | add a file LINK to the lead's Notes & files card (no paid storage -- `url` points wherever the file already lives); audited |
| `lead_files_remove` | `{id}` | remove a file link; audited |

`lead_profile`'s response:

```
{
  detail: { company, contacts, sources, enrichment, verification, touches, history, events, comments, tasks, actors },
  milestones: { first_touch, first_open, first_reply, last_activity },   // ISO strings or null; from lp.lead_events + lp.campaign_touches only
  reachability: [{ key, label, value, ok }],                              // verified_email, store_phone, owner_phone, linkedin
  segments: { available, needs_migration, memberships: [{ id, name, kind, campaign_id }] },
  campaigns: { available, needs_migration, memberships: [{ campaign_id, campaign_name, status, added_at }] },
  files: { available, needs_migration, rows: [{ id, company_id, contact_id, name, url, note, uploaded_by, uploaded_by_name, created_at }] },
  score: { available, needs_migration, row },                            // row is whatever plan 2.8's lp.scores has, once merged
  suppression: { checked, suppressed, reason },
  engagement: { available, benchmarks: [{ campaign_id, campaign_name, lead: {opens, replies, steps}, campaign_average: {opens, replies, steps} }] },
  placeholders: { journeys: "Not built yet", deals: "Not built yet", conversions: "Not built yet" },
}
```

**UI:** `app/leads/[id]/page.tsx` is now tabbed (`?tab=overview|timeline|engagement|details`,
plain query params, no client JS to switch): Overview (header with stage/score/owner/
suppression, milestones, reachability, Segments & lists, Campaigns, Tasks, Notes &
files, Comments, and the Journeys/Deals/Conversions placeholders), Timeline (lead
events with a category filter + search, plus campaign activity), Engagement (the
benchmark), Details (the previous deep-dive: store facts, readiness, contacts,
research findings, verification history, change history, sources) -- every existing
feature (inline edit, comments, the history drawer, the "Forget" menu if present)
still lives there, just regrouped.

**Extends:** `lib/leads/detail.ts` (added `category` to each timeline event, from
`lp.event_types`), `components/leads/LeadTimeline.tsx` (category + search filter,
exported as the pure `filterEvents` for testing), `components/leads/CommentForm.tsx`
and `components/comments/*` keep working unchanged.

**Migration:** `0034_lead_files.sql` -- `lp.files` (file links only; id, company_id,
contact_id nullable, name, url, note, uploaded_by, created_at), and the canonical
`status_history_entity_type_check` superset (this is the migration that uses it,
since file links need the `'file'` entity type).

Deferred from this slice: the per-campaign deal pipeline (Deals is a placeholder
until plan 3.x/4.x), journeys and conversions likewise (3.x), and the score card
reads plan 2.8's `lp.scores` table read-only -- scoring itself is built elsewhere.
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

## Tags: changing a tag is an explicit, counted choice (Oct 11, 2026)

A tag is never silently changed on every lead.

- `change_tag` `{from, to, company_id? | company_ids?: number[] | segment_id?, preview?: boolean, expected_count?}` changes the tag only on one lead, on the leads you list, or on a segment's leads. A static list uses its members; a dynamic segment uses its rules. `preview: true` returns `{count, scope}` and changes nothing. A change to more than one lead needs `expected_count` equal to that count, and a moved count is refused with 409. It writes one audit entry (who, old name, new name, how many leads) and no per-lead timeline rows. Anyone but an owner (agent keys and Editors) may change at most 500 leads in one call; a bigger change gets 403, so ask the owner. Merged-away leads are never counted or changed.
- `rename_tag` `{from, to, expected_count}` and `merge_tags` `{tags, into, expected_count}` change the tag on every lead. They are owner-only: an agent key gets 403, and agents use `change_tag`. They also need `expected_count`, and each writes one audit entry with no per-lead timeline rows.
- `count_tagged` `{tags: [string,...]}` returns how many leads carry any of the tags now.

Roles, also Oct 11: managing people and roles, agent keys, agents, the Tools hub and jobs is owner-only in the dashboard. No ops-API op changes people or roles, and the database refuses such a change from any non-owner (migration 0050).

