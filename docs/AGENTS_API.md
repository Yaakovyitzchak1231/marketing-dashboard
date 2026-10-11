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
