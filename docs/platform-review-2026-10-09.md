# Marketing dashboard: deployment, communication and modular admin review

Date: 2026-10-09. Repository baseline: `fbb200d39a167ad77822c591d62eb57821752f2c`. Working branch: `fix/agent-notification-reliability`.

## Executive recommendation

Build one modular control center for marketing work, not another disconnected dashboard and not a clone of the entire WordPress plugin ecosystem. Keep WordPress/Yoast as the content and SEO execution system; keep this Next.js application as the shared work queue, reporting, approvals and evidence layer. Make agents dependable before making them more autonomous.

The immediate breakdown is concrete: notification rows exist, but there is no working push route to their recipient and seeded actors lack pull channels. More models or an additional agent framework would not fix this.

## Review method and boundaries

- Sequential stages: inventory → live configuration/row evidence → independent architecture/development review → scoped fixes → tests/build → controlled activation plan.
- Vercel inspection used the authenticated integration with allowlisted metadata only. No environment values, credentials or raw build logs were disclosed.
- Neon inspection used read-only SQL in the Vercel-managed project, not the unrelated personal Hermes or Jules projects.
- Separate architecture and development workers reviewed the repository. Their reviews were static; live database and deployment findings below were independently collected by the coordinating session. In-process reviewers returned no results; the separate worker reviews were retrieved from their session reports. The coordinating session implemented and tested the fixes.
- No deployment, production migration, task creation, notification send, WordPress write, paid provider invocation or service installation was performed.
- DOM checks use Testing Library/jsdom. They are not a logged-in production browser check or a cross-browser/mobile visual verification. No throughput/load test or live agent receipt test has been performed.

## Verified production evidence

### Vercel and build

Project `marketing-dashboard`, project ID `prj_ck8vqz011QJGSkgOGo99hme3VexW`.

Production deployment `dpl_E6xHUV3dJdCF3nnuX8hTJbUubGTu` is **READY**, points at baseline commit `fbb200d`, and serves `https://marketing-dashboard-xi-five.vercel.app`. All five latest deployment records inspected were READY; this is a five-record review, not a full deployment history audit.

Named API responses: `VERCEL_GET_PROJECTS`, `VERCEL_GET_DEPLOYMENTS`, `VERCEL_GET_DEPLOYMENT`, `VERCEL_GET_DEPLOYMENT_EVENTS2`.

- Effective build command: `npm run vercel-build` (migrations, then Next build).
- Production build-log signals: migration completion and compilation success present; migration-failure signal absent; Node engine warning present.
- Effective runtime: **24.x**; project setting: **22.x**; CI: **22**; package engine: previously **>=22**. Vercel chooses the newest supported major allowed by this range. The patch pins `22.x` using npm and changes no dependency version.
- Region: `iad1`; function type: fluid; deployment default function timeout: 300 seconds. The existing stream routes explicitly limit themselves to 60 seconds.
- No deployed cron schedules (`crons: []`).
- Database configuration keys are targeted to both production and preview. This does not by itself prove the resolved URLs are identical, but preview isolation must be verified before treating preview writes as safe.
- Mail settings `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM`, and scheduler `CRON_SECRET` are absent from project environment-key metadata. Agent token configuration exists for production. Database-issued agent keys are also supported in code.

### Neon and data

Project `tapdashmarketingdashboard` (`solitary-feather-20137611`) in Vercel-managed organization `org-lucky-boat-79707347`; branch `main` (`br-odd-union-b7wc19r1`).

Named API responses: Neon `list_organizations`, `list_projects`, `list_branches`, `run_sql`.

- PostgreSQL 18.6; branch READY; AWS us-east-1, colocated geographically with Vercel iad1.
- All **15 baseline migrations** recorded in `public.lp_schema_migrations`.
- Stored rows at inspection: **25,189 companies**, **26,473 contacts**.
- Project metadata reports minimum and maximum compute both **0.25 CU**: no compute autoscaling range is configured. This is not proof of current capacity exhaustion and no capacity benchmark was run.
- Branch metadata reports not protected. History retention metadata: **21,600 seconds (6 hours)**; a tested independent backup/restore policy is still needed.
- SQL reported max_connections **112**; this is a setting, not an application concurrency guarantee. Each application pool can use five connections, and many serverless instances can each create a pool.
- `pg_stat_ssl` through the Neon SQL integration reported false for that integration session. This does **not** establish the TLS properties of Vercel's pooled connection; the proxy path and application connection must be assessed separately.

### Agent delivery: confirmed root cause

Read-only queries joined `lp.actors`, `lp.delivery_channels`, `lp.notifications`, `lp.deliveries`, and `lp.tasks` without retrieving message bodies, channel configuration or keys.

- Tab is registered as **`tab`**, not `tab.ai`.
- Exactly one configured delivery channel at inspection: **Tab email**, enabled, no recorded successful delivery, an error present.
- **Four Tab notifications**, all unread: one assignment, two direct messages, one handoff.
- **Four email deliveries held**, oldest created **2026-10-09 14:56:31 UTC**.
- Other seeded agents have no delivery channels. None of the registered actors had an active database-issued key at inspection; environment-token identities were not inspected, so this is not a claim that no agent has credentials.
- Tab last recorded check-in: **2026-10-09 19:08:39 UTC**. Other seeded agent check-ins were not recorded. A check-in does not prove a persistent listener is running.

Source confirms `feed()` only reads fetchable delivery channels (pull/stream/MCP/ntfy). A stored email-only notification therefore cannot be retrieved through that feed. `addActor()` creates pull channels for new agents, but historical seeded actors never received them. Missing mail settings put Tab's email on hold; together, these defects explain why messages can be saved without reaching Tab.

## Scoped changes on the working branch

1. Add an additive migration for legacy agent feed access and unread-notification backfill. Preserve deliberately disabled delivery choices.
2. Honor disabled channels during dispatch/feed; cap each dispatch at ten rows with five concurrent workers and bound relay network time. This reduces the previous batch/lease-overrun risk; database latency and end-to-end throughput still need measurement. Mark sibling fetch channels together to prevent immediate duplicate offers, and preserve acknowledgements if a push settles later.
3. Add missing immediate-dispatch hooks for lead comments, Find leads tasks, research tasks and SEO actions.
4. Return REST/MCP feed data without waiting for unrelated outbound mail or webhook retries. Schedule push work after the response.
5. Add a scheduler-only authenticated retry endpoint, `/api/ops/deliveries/dispatch`, with fail-closed auth, global pause enforcement, bounded work and no-cache responses. It is **not activated on a schedule** by this branch.
6. Add delivery-readiness evidence and mail/scheduler prerequisites to Settings, with unavailable states on query failure and no secret values.
7. Pin Node 22.x and correct outdated deployment documentation.

The implementation strengthens existing PostgreSQL/Next.js mechanisms rather than installing a second notification platform. Live wake-up still requires a configured destination and a running recipient, plus a scheduler/worker for unattended retries.

## Remaining risks and next engineering work

### Before activating unattended agents

- **Production activation:** configure a real Tab mail provider or an approved webhook/listener, provision per-agent credentials securely, apply/review the migration through the normal deployment, then run an approved end-to-end receipt/acknowledgement test. Do not call the issue operationally resolved until that test passes.
- **Independent retries:** connect one trusted scheduler; monitor queue age, not just successful HTTP responses. Existing streams/polling are not a durable background service.
- **At-least-once side effects:** provider timeouts can occur after acceptance. Deduplicate by notification/correlation ID and use provider idempotency support where available. Lease bounds reduce duplicate risk but do not make network side effects exactly once. Add real multi-connection Postgres race tests before increasing throughput.
- **Relay contract:** keep anti-loop protection. The current Hermes adapter defuses all mentions, including human escalation; no-task messages from agents do not receive an automatic reply. Worker review also flagged pinned-comment routing and interrupted-run recovery for focused follow-up. Do not simply remove the anti-loop guard. Prefer explicit tasks/results; add correlation IDs, hop limits and sender policies for conversational workflows.
- **Security advisories:** `npm audit` at review reported **18 advisories: 2 critical, 10 high, 6 moderate**, including development tooling and runtime/transitive packages. This is not a claim of 18 remotely exploitable application bugs. Proposed package upgrades require approval; no dependency was upgraded automatically. Do not use `npm audit fix --force` indiscriminately.

### Before scaling beyond the current owner/workspace

- The authorization design is single-owner (`ALLOWED_USER_EMAIL`, actions acting as `owner`), not multi-tenant RBAC. Add explicit workspace ownership, roles/capabilities, scoped agent tokens and scoped queries before additional customers/users.
- `getDb()` keeps a per-process pool, not a global connection limit across Vercel instances. Use the Neon pooled URL, assess total connections under load, set connection/query timeouts, and consider Vercel pool lifecycle integration after dependency review.
- Runtime/migration TLS helpers contain `rejectUnauthorized: false` paths. Validate provider certificates and connection-string parsing before replacing this with a consistent verified-TLS policy. No live Vercel TLS handshake was tested.
- Production migrations run during build, before application traffic switches. Keep migrations additive/backward compatible with the old deployment; test expand/contract changes and rollback. Use branch-per-preview DB isolation, not just a “skip preview migrations” flag.
- Webhook/WordPress/crawl destinations need centralized URL validation, private-address/DNS-rebinding protections, scoped credentials, timeouts, bounded responses and safe redirect policies before untrusted users can configure connectors.
- Long SEO audits, enrichment and AI checks should run as durable background jobs with progress/checkpoints; Vercel requests should enqueue and return. Add retention/archival for delivery/event tables and indexes driven by actual query plans.
- Existing insights are useful rules grounded in campaign counts, not a substitute for measured causality or reliable forecasting. Keep unavailable metrics unavailable.

## Product direction: WordPress flexibility without a rewrite

The current SEO module already includes audits, AI-answer checks, search-console integrations, fix tasks, WordPress draft creation, limited Yoast metadata edits, schema changes, previews and undo. Their presence in code does not establish that their production credentials, WordPress bridge or all provider integrations are configured.

### Module 1 — Content and SEO desk

- Browse/search WordPress pages and posts; edit drafts, categories, tags, featured media and alt text; view revisions and publication status.
- SEO title/description, canonical, robots directives, schema and social previews, plus measured search performance.
- Capability discovery for each connected site. Show “not supported” when a plugin/API cannot perform an action. Offer a deep link to native WordPress Admin for Elementor layout editing, plugin management and site-wide operations rather than pretend to support them.
- Preview → explicit approval → apply → verify the actual rendered result → retain before/after evidence → undo where safe.
- Start with a site adapter boundary around existing `lib/seo/wordpress.ts`, not a new headless CMS migration.

**Important Yoast nuance:** the traditional Yoast REST metadata endpoint is read-only. Current official Yoast Abilities documentation also describes separate read/write abilities for a limited set of fields (canonical, indexing directives, schema types, cornerstone status). Do capability/version discovery on the actual site; do not assume those newer abilities write titles/descriptions or are installed. The current custom metadata bridge should be reviewed and packaged as a small, versioned, least-privilege WordPress plugin rather than indefinitely relying on pasted PHP snippets.

### Module 2 — Shared work and notification inbox

One searchable inbox across comments, tasks, approvals and agent results; saved views; filters; visible delivery/acknowledgement; an actionable connection check per agent; configurable notification preferences. Add “turn this comment into a task” using the existing task model. Keep human and agent identities explicit.

### Module 3 — Proactive recommendations

Start with explainable scheduled checks: stalled tasks, overdue replies, failed delivery, failed SEO checks, stale data and unusual campaign metrics. Each recommendation stores source rows/API references, observation time, rule/model version, confidence limitations and a suggested action. Deduplicate repeated alerts, add cooldowns and route only actionable items.

Autonomy ladder: observe → recommend → draft → request approval → execute only approved scope → verify. A daily briefing and exception inbox are better first steps than fully autonomous publishing or campaigns. Add per-run spend/token budgets and a kill switch before paid model orchestration.

### Module 4 — Knowledge and evaluation

Search existing task history, approved content and agent memory first. Add PostgreSQL full-text search before adopting a vector system; evaluate pgvector only if measured retrieval quality justifies embeddings. Retrieved text is evidence, not instructions. Track provenance, freshness and workspace access. Evaluate proposed answers/actions against fixtures and real reviewed examples before changing model policies.

### Module 5 — Platform administration

Connection health, per-module settings/capabilities, roles, audit log, job progress/retry, export/backup, reversible change history and feature flags. A module contract should own routes, permissions, operations/events, settings, migrations and background job handlers; keep the initial deployment a modular monolith rather than prematurely splitting into microservices.

## Open-source shortlist (proposals, not installed)

| Tool | Purpose | Recommendation |
| --- | --- | --- |
| WordPress + Yoast interfaces | Keep mature content/SEO execution and plugin compatibility | Extend the current adapter; discover capabilities and preserve native-admin escape hatches. |
| ntfy | Lightweight agent wake-ups | Existing adapter already uses it. Evaluate authenticated self-hosting and recipient reliability; no new dependency is needed just to repair feeds. |
| pg-boss | PostgreSQL-backed durable jobs/retries/rate limits | Best candidate when migrating long jobs and delivery execution out of request lifecycles. Run workers outside Vercel request functions; approve dependency first. |
| OpenTelemetry | Trace task creation through enqueue, delivery and completion | Add after stable event/correlation IDs; scrub payloads and secrets. Choose an observability backend separately. |
| PostgreSQL full-text / optional pgvector | Evidence retrieval | Start with built-in text search. Add vector storage only after an evaluation demonstrates value. |

Avoid installing several overlapping workflow systems, adding Redis solely for an existing low-volume queue, or promising all WordPress plugins can run inside Next.js. Tools should solve observed needs, not become a new integration burden.

## Acceptance criteria for the next release

- Legacy and newly registered agents can receive tasks, mentions and handoffs via their own feed; disabled channels remain disabled.
- Unauthorized agents cannot call the scheduler endpoint or acknowledge another recipient’s delivery.
- A provider outage is retried with no browser open; an acknowledged event does not cause duplicate agent work.
- A pinned comment/task created by the human reaches the selected agent; a deliberate handoff reaches a second agent and produces a visible result without an agent-message loop.
- Settings display stored delivery states and prerequisites; unavailable sources are never rendered as zero.
- CI/local Node major matches Vercel; preview writes cannot reach production; tests and a production build pass.
- A future SEO edit is previewed, approved, applied, verified and undoable without bypassing WordPress capabilities.

## Sources

- [Vercel Node.js version selection](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [WordPress REST API resources](https://developer.wordpress.org/rest-api/reference/)
- [WordPress roles and capabilities](https://developer.wordpress.org/apis/security/user-roles-and-capabilities/)
- [Yoast REST metadata API](https://developer.yoast.com/customization/apis/rest-api/)
- [Yoast post SEO abilities and permissions](https://developer.yoast.com/features/yoast-seo-abilities/posts-seo-data/)
- [pg-boss](https://pgboss.io/)
- [ntfy access-control configuration](https://docs.ntfy.sh/config/)
- [OpenTelemetry](https://opentelemetry.io/docs/what-is-opentelemetry/)

Operational instructions: `docs/agent-delivery.md`.

## Final local validation

All commands below completed with exit code 0 after integration:

- `npm run check`: TypeScript, ESLint and **920 tests in 76 files passed** (baseline: 896 tests in 70 files).
- `npm run lint:strict`: no lint warnings or errors.
- `npm run build`: production build compiled successfully.
- `npm run vercel-build`: actual Vercel build command compiled successfully; the migration step correctly skipped because the local environment has no DATABASE_URL. This did not apply production migrations.
- `git diff --check`: no whitespace errors.

Regression coverage includes legacy migration/backfill idempotence, unread and already-acknowledged boundaries, tasks/messages/handoffs/mentions, pinned-comment feed content, disabled channels, multi-channel duplicate suppression, acknowledgement/settlement races, bounded batch/concurrency, scheduler credentials/global pause, nonblocking feed responses, missing dispatch hooks, and rendered Settings DOM with safe unavailable states.

No live agent receipt, provider delivery, production DOM, multi-connection race, load or post-deploy smoke test is claimed. Those remain release gates. The branch adds no external dependencies and upgrades no dependency versions; only Node engine metadata was pinned through npm. Changes are local and not deployed.
