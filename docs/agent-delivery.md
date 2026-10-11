# Agent delivery: readiness and activation

## What is connected to what

The app is a modular Next.js application, not a WordPress replacement. Supabase handles human login; Instantly provides campaign measurements; PostgreSQL (Neon in production) stores leads, tasks, comments and delivery state. Every agent has its own actor ID and credential. Tab's ID is `tab`: use `@tab`, not a product name such as `@tab.ai`, unless that exact ID was separately registered.

Notifications are committed with the underlying task/comment. A database trigger creates delivery rows in the same transaction. Push attempts run after the HTTP response; a slow mail provider must not hold up the agent feed. A queued row is not proof that an agent received or acted on it.

## Existing agents and feeds

Migration 0016 supplies a pull channel for existing active agents without a fetchable channel, while respecting deliberately disabled channels and excluding internal system/Instantly actors. It backfills unread notifications, so enabling feed access does not lose earlier requests. New agents already get a pull channel.

Agents can use REST (`/api/ops/feed`), SSE (`/api/ops/stream`) or MCP (`/api/ops/mcp`), authenticated with their own bearer credential. Pull/MCP access is not a wake-up mechanism: something must actually call it. After receiving an event, acknowledge its `delivery_id` through `/api/ops/feed/ack`. Task completion is separate. Receivers must deduplicate by notification ID and claim a task before work; network delivery is not an exactly-once side-effect guarantee.

## Immediate delivery

Choose a working push adapter on the agent's page:

- **Tab email:** the built-in email channel needs `MAIL_PROVIDER` (`resend` or `brevo`), `MAIL_API_KEY`, and a provider-verified `MAIL_FROM`. Store credentials in Vercel's secret fields, never in chat or URLs. Without them, email stays held without exhausting attempts. The mail provider accepting a message means sent, not that Tab has processed it.
- **Webhook:** register an agent-controlled HTTPS receiver, verify the timestamp/HMAC signature, reject replays, and deduplicate events. Do not use an arbitrary URL supplied in a comment. The current URL validation needs additional private-network/SSRF hardening before broader untrusted administration.
- **ntfy + relay:** the existing Hermes adapter can listen for wake-up IDs, then fetch authenticated content. Deploying that service is a separate operator action. An unguessable public topic is not equivalent to access-controlled private infrastructure; evaluate a protected self-hosted ntfy instance before sensitive/multi-tenant rollout.
- **SSE/polling:** useful as a fallback, but a permanently open Vercel stream consumes runtime and database activity. It is not a durable worker.

A human can inspect channel kinds, unread/held/failed counts and last recorded check-in under **Settings → Can the agents hear you?** The counters are read from stored rows. Query failures render unavailable, not zero. A configured channel or a recent check-in alone is not proof of a running listener.

## Independent retries (opt-in)

`GET /api/ops/deliveries/dispatch` runs a bounded batch of due delivery work. It accepts only `CRON_SECRET` via bearer authentication, not normal agent keys, and respects the global agent pause. Missing credentials or database access fail closed. It returns measured dispatch counts with `Cache-Control: no-store`. Each batch claims at most ten rows and uses at most five concurrent workers; overflow stays queued for the next request. Relay wake-up attempts share a per-delivery network deadline. These bounds leave runtime headroom but do not replace database timeouts or real load tests.

This endpoint is intentionally **not scheduled by this change**. After operator approval:

1. Store a random scheduler credential (at least 32 characters) in Vercel and the scheduler's credential store.
2. Configure one scheduler (a Vercel Cron frequency supported by your plan, or an existing trusted external worker) to call the production endpoint. A one-minute cadence is a possible recovery target, not a measured delivery guarantee. Never put the credential in the URL or a committed cron command.
3. Set/review provider rate limits and queue backlog alerts before raising concurrency.
4. Redeploy, then verify a controlled task, comment, agent-to-agent handoff and acknowledgement end to end. These send notifications and change rows, so run them only with explicit approval.
5. Test a temporary provider failure: the row should retry even with the dashboard closed. Record timestamps for created, sent and acknowledged states.

Immediate first attempts do not wait for the scheduler. The scheduler is the recovery path after an interrupted function, missed ping, provider outage or a batch larger than one dispatch. Merely setting `CRON_SECRET` does not activate it.

## Task claim safety

Store the `attempts` number returned by `claim_task` and send it as `claim_attempt` with heartbeat, completion, failure and handoff operations. After a retry or expired-lease reclaim, an earlier attempt cannot write or complete the new claim, even when both processes use the same actor ID. For compatibility, the server accepts an omitted attempt only on a task's first claim. Callers should always supply it. An expired lease must be reclaimed; a heartbeat does not revive it.

The engine's direct database path checks individual/global pause as well as the active claim before checkpoints. Research application and task completion share a transaction. Agents cannot bypass that through the human `update_task` operation. A pause is cooperative: it refuses subsequent work/commits; it cannot undo an external request already sent.

## Communication safety

Feed events carry `page_comment_id` for pinned-comment threads and `auto_reply` for informational responses. Relay clients must not start a run for `auto_reply: true`. Use `send_message` with `no_reply: true` for an automatic result rather than a new request. This is a stop-after-one-reply protocol, not unrestricted agent conversation. Keep sender allowlists and agent-mention suppression; human escalation must remain visible. A future multi-turn conversation protocol needs correlation IDs, hop limits, sender permissions and budgets first.

Mention notifications carry the full stored comment body, not just the short inbox summary.

No change here bypasses the human approval gate for publishing, campaigns, paid verification or destructive work. The application remains single-owner; workspace-scoped authorization must precede multi-tenant access.

## Release and rollback

Run `npm run check` and `npm run build` before review. Release through a PR; do not merge automatically. Production builds apply additive migrations; previews skip migrations by default but still need a separate Neon branch to prevent preview writes reaching production. Pin Node to 22.x to match CI and Vercel project settings.

Deploy the server and updated engine/relay as a coordinated release. Existing clients must retain claim attempts before handling retries; old relay versions do not recognize informational replies or pinned-comment IDs. Do not enable the new automatic reply behavior against an old server. Review migrations 0017–0019 as well as the earlier feed-access migration.

No production deployment, database migration, provider configuration or relay installation is performed by this branch alone. On rollback, retain delivery history and the additive pull channels; revert application code rather than deleting notification rows. If stopping outbound delivery is necessary, disable the relevant channels and scheduler, and verify that existing in-flight requests have settled.
