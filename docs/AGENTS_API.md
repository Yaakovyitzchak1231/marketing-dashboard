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
`complete_task`, `fail_task`, `handoff_task`, `send_message`.

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
