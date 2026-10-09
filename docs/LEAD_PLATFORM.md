# Lead platform (Phase 1)

One database for every lead, every check, every campaign event and every piece of
teamwork between you and the agents. The Lead Master Sheet becomes a read-only copy.

## How the agents work together (plain English)

Think of it as a small office where some teammates are people and some are agents
(Tab, Hermes, Claude, Manus). Everyone uses the same board, the same lead list and
the same activity log, so there is one source of truth.

- **Tasks.** You (or an agent) put a task on the Team board and assign it to someone,
  or leave it for whoever picks it up first. When an agent picks a task up it holds it
  for a few minutes at a time and keeps checking in ("40 of 200 done"). If it goes
  quiet, the task frees itself and someone else can take it. Nobody works on the same
  task twice.
- **Checking out.** Before an agent changes a campaign, a lead list or a lead, it
  "checks it out" like a library book. Anyone else who tries sees who has it and waits.
  You can take a checkout back from the Activity screen at any time.
- **Notes and @mentions.** Every task and every lead has a thread. Writing `@tab` or
  `@hermes` in a note puts it in that teammate's inbox; agents read their inbox through
  the same API. Handing a task to someone else always carries a note on where it stands.
- **Your OK first.** Anything that leaves the building or costs money (loading leads into
  a campaign, sending, a paid verification run) is asked for as an approval. Only a
  person can approve, never the agent that asked. Pending requests sit at the top of the
  Activity screen with Approve / Reject.
- **Memory.** Each agent has its own notebook (what it learned, your preferences for it)
  plus a shared team notebook. You can read and edit every note on the Agents screen.
  Every change is logged.
- **Activity.** Every action by every teammate lands in one feed, in plain sentences.
  The log can't be edited or deleted.

## Screens

| Screen | What it's for |
|---|---|
| Overview `/` | Where leads stand: by stage, research and verification backlog, replies waiting, recent activity |
| Leads `/leads` | Views: table, kanban by stage, by campaign, by state, needs research, needs verification. Filters, bulk actions, lead detail with sources, enrichment, verification history, campaign touches, status history and comments |
| Find leads `/find` | The lead engine: pick segment, area and size, run it, watch progress |
| Verification `/verify` | Free check, then MillionVerifier, then ZeroBounce only for catch-all/unknown, with a cost preview and an Approve click before anything paid |
| Campaigns `/campaigns` | The Instantly dashboard (PR #35) |
| Replies `/replies` | The reply desk, fed by the Instantly webhook |
| Team `/team` | The shared board: humans and agents create, claim, comment, hand off |
| Agents `/agents` | Who is working on what; each agent's page lets you assign it a task and edit its memory |
| Activity `/activity` | The feed, pending approvals, and active checkouts |

## The lead engine (Find leads)

The same method that built the Lead Master, as code: Google Maps search by city and
query -> drop chains, pawn shops, non-jewelers and stores without their own site ->
read each store's own website (contact/about pages) for emails, owner names, phones and
POS/surcharge hints -> owner search (when a search provider is set) -> write everything
into the database with the page it came from. Every business is a checkpoint row, so a
job that crashes or is cancelled picks up where it stopped. Proxies rotate from
`ENGINE_PROXIES`; each store's site gets one request at a time with a gap, and a host
that answers 429 is rested.

Jobs are tasks assigned to Tab by default. You start one on the Find leads screen; a
runner on the OVH server picks it up: `npm run engine -- worker --agent tab`. One-off:
`npm run engine -- run --cities "Towson, MD" --max 50`. Details, every stage, the
env vars and the honest terms-of-service notes: [docs/lead-engine.md](lead-engine.md).

Any agent can also research a single lead: `POST /api/research/enqueue {company_ids}`
(the "Research selected" button) creates `research_company` tasks; the built-in runner
reads the store's site, or an agent claims the task and submits what it found as
`complete_task {result: {research: <ResearchResult>}}` (evidence URL required per fact).

## Verification

Free check first (syntax, mail server, disposable domains; role and free-provider
addresses are flagged), then MillionVerifier, then ZeroBounce only for what
MillionVerifier calls catch-all or unknown. Leads whose Sheet result was already
catch-all/unknown at MillionVerifier go straight to ZeroBounce. Nothing paid runs
until you click Approve on a cost preview with a dollar ceiling; spend never passes
the ceiling. Prices (Oct 8, 2026 list prices) are in `lib/verify/pricing.ts` and can be
overridden with `MV_COST_PER_CHECK` / `ZB_COST_PER_CHECK`.

## The database

Plain PostgreSQL 13+ in its own schema, `lp` (`db/migrations/`). No Supabase-only
features, so it can live in the existing Supabase project now and move to the OVH
server later with `pg_dump -n lp`.

- Leads: `companies` (one per store), `contacts` (one per email), `sources`,
  `enrichment` (one fact per row, with evidence), `verification_runs`,
  `verification_results`, `campaign_touches`, `status_history` (written by triggers).
- Teamwork: `actors` (people and agents), `projects`, `tasks`, `locks`, `comments`,
  `notifications`, `approvals`, `agent_memory`, `events` (append-only).
- Dedupe rules: one company per website domain, per phone (E.164), per
  name+address; one contact per email. Social/marketplace links (Facebook, Etsy, eBay…)
  never count as a store's domain.

Apply migrations: `DATABASE_URL=postgres://... npm run db:migrate` (`--status` to list).

**On Vercel the migrations run by themselves.** `vercel.json` sets the build command to
`npm run vercel-build` (`db:migrate --on-build`, then `next build`). On a production build
with `DATABASE_URL` set (Vercel → Storage → Neon, prefix `DATABASE`), every pending file in
`db/migrations` is applied in order, each in its own transaction under an advisory lock, so
a re-run or two builds at once are safe. With no `DATABASE_URL` the step prints why it
skipped and the build carries on (CI, previews without a database). Preview builds skip by
default because they usually share the production database (`MIGRATE_ON_PREVIEW=1` to
opt in; `MIGRATE_ON_BUILD=0` turns the step off). `DATABASE_URL_UNPOOLED` is used for
migrations when the Neon integration provides it. A failing migration fails the build, so
Vercel keeps serving the last good deploy.

Missing keys: every "Setup needed" card lists the keys a screen reads (required vs
optional, set or missing, never the value) with click-by-click steps and a button straight
to the project's Vercel Environment Variables page; `/setup` shows all of them at once,
plus how many migrations have run and how many leads are loaded.

### Moving the Lead Master in

```
DATABASE_URL=postgres://... npm run import:lead-master -- --csv lead_master.csv
# or straight from the Sheet's CSV export:
DATABASE_URL=... LEAD_MASTER_CSV_URL='https://docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=<gid>' \
  GOOGLE_ACCESS_TOKEN=<read-only token> npm run import:lead-master
```

Read-only on the Sheet. Safe to run again: matches existing rows, never duplicates,
never overwrites a value already in the database; contacts keep the database's status
after the first import. Measured on a local Postgres with the Oct 6 export: 24,316 rows
-> 23,951 companies, 24,316 contacts, 14,898 MillionVerifier results, 495 campaign
touches, in 47 seconds; a second run added nothing.

### Loading the Lead Master without the database URL

An agent with a token from `OPS_AGENT_TOKENS` can load rows over HTTPS instead:

```
OPS_URL=https://<app>.vercel.app OPS_TOKEN=<agent token> \
  npm run push:lead-master -- --csv lead_master.csv --dry-run   # counts only, writes nothing
OPS_URL=https://<app>.vercel.app OPS_TOKEN=<agent token> \
  npm run push:lead-master -- --csv lead_master.csv             # the real load
```

It posts gzip-compressed chunks (1,000 rows each, `--chunk` to change, at most 5,000) to
`POST /api/ops/import/lead-master`, which runs the same `importLeadRows` as the script above,
so it is just as idempotent: a re-sent chunk is matched, never duplicated. `?dry_run=1`
runs the import inside a transaction and rolls it back, so the counts are real and
nothing is written (each chunk is counted on its own, so a chunked dry run can count a
company twice when its rows span chunks). A failed chunk prints `--start N` to resume.
`GET` on the same path returns the current contact and company counts. The body also
accepts a plain CSV (`Content-Type: text/csv`) or `{"rows": [...]}` JSON.

## The ops API (for agents)

Every agent gets its own token: `OPS_AGENT_TOKENS="tab:<token>,hermes:<token>,claude:<token>"`
(24+ random characters each; the id must exist in `lp.actors`). Requests carry
`Authorization: Bearer <token>` and act as that agent only.

**Pausing an agent.** On the Agents page (`/agents`) a signed-in person can pause any
agent (with an optional reason) or press "Pause all agents". While paused, every
`/api/ops/*` request from that agent gets `423` with `{"ok": false, "error": "... agent
paused by Yaakov: \"reason\" ...", "paused": {scope, by, by_name, at, reason}}` and nothing
runs. Its token, tasks, claims, locks and memory are left as they are (leases still expire
on their own, so another agent can pick the work up). Pause state is stored in the database
(`lp.actors.paused_*`, `lp.agent_pause_all`, migration 0008); only a human can pause or
resume, a human can never be paused, and each pause/resume is an activity-log row
(`agent.paused`, `agent.resumed`, `agent.paused_all`, `agent.resumed_all`). The check lives
in one place, `lib/ops/gate.ts`, which every ops route uses; if the pause state can't be
read the request is refused (503).

- `GET /api/ops` lists every op and its arguments.
- `POST /api/ops` with `{"op": "...", ...args}` runs one.
- REST aliases: `POST /api/ops/tasks/claim`, `POST /api/ops/tasks/:id/heartbeat|complete|fail|handoff|comment`,
  `POST /api/ops/locks/acquire|release`, `POST /api/ops/events`, `POST /api/ops/approvals`,
  `GET /api/ops/approvals/:id`, `GET|POST /api/ops/memory`, `GET /api/ops/inbox`, `POST /api/ops/presence`.

Ops: `whoami`, `presence`, `create_task`, `list_tasks`, `get_task`, `claim_task`,
`heartbeat`, `complete_task`, `fail_task`, `handoff_task`, `update_task`, `comment`,
`acquire_lock`, `release_lock`, `list_locks`, `log_event`, `request_approval`,
`get_approval`, `memory_get`, `memory_put`, `memory_search`, `memory_delete`, `inbox`,
`mark_read`, `recent_events`.

A typical agent loop:

```
claim_task {kinds:["research_company"]}          -> a task, or null
heartbeat {task_id, progress:{done, of}}         -> every lease/2 (default lease 300 s)
acquire_lock {resource:"campaign:<id>"}          -> before touching shared things
request_approval {action:"send", summary, task_id} -> then poll get_approval
complete_task {task_id, result, report}          -> report shows on the task and the agent's page
```

Instantly's own AI can't take locks, so treat campaigns it runs as checked out to
`instantly-ai`.

## Instantly webhook

`POST /api/webhooks/instantly`, authenticated by `INSTANTLY_WEBHOOK_SECRET` sent as a
custom header (`Authorization: Bearer <secret>`). Each event becomes a campaign touch
(retries are ignored), moves the lead forward (sent -> contacted -> replied ->
interested -> meeting; bounce marks the address invalid; unsubscribe marks
do-not-contact), and replies open a task on the Reply desk. Unknown addresses are
stored without inventing a lead.


## Campaign email steps (0012)

Each dashboard campaign has ordered email steps (Steps tab: `/campaigns/:id/steps`).

- **Steps:** subject + body with `{{field}}` placeholders, wait (days) before the step, and a variant
  label (A/B copies share a step number). Add, edit, reorder (↑ ↓), delete. Every change is in the
  activity log with who did it and each field's old → new (a deleted step's full text stays in the log).
- **Where `{{field}}` values come from**, first match wins: the campaign-lead override → the lead's own
  field → an enrichment fact (best confidence, then most recently checked) → the field's fallback text.
  The field list comes from the campaign's lead rules (0010: its own set `rule_set_id` → its pool's → default).
- **Preview:** pick a lead and see every step filled. It lists each value and where it came from, flags
  required fields with no real value (→ Ready-generic copy) and any `{{...}}` that would go out unfilled
  (→ would be Parked), and shows the rules evaluator's stored verdict when there is one.
- **Copy checks** (warnings, never blockers): no links, 55–80 words, ends with a question.
- **Instantly (optional):** a person can link the campaign to an Instantly campaign id (stored only).
  "Ask to push" creates a *pending request*; nothing in this feature calls Instantly. Only the human
  approval flow (Needs your OK, PR #46) sends, and only Ready leads. Agents can edit steps and ask for a
  push; they cannot link or approve (a database trigger refuses an agent's approval).
  One dashboard campaign per Instantly campaign: Add to Instantly then scores leads with the linked
  dashboard campaign's rules (`ruleSetForCampaign`), so the upload matches what the Steps tab shows.

API (same contract on both doors; see `lib/campaign-steps/http.ts`):
people `/api/campaign-steps/:campaignId/...` (login), agents `/api/ops/campaign-steps/:campaignId/...` (ops token).

| Method | Path | Does |
|---|---|---|
| GET | `/` | campaign, steps (with copy warnings), fields, push requests |
| POST | `/` | add a step `{subject, body, delay_days?, variant?, step_number?}` |
| PATCH / DELETE | `/:stepId` | edit / delete a step |
| POST | `/reorder` | `{order: [current step numbers in the new order]}` |
| GET | `/leads` | the campaign's leads |
| GET | `/preview?lead=<id>` | every step filled for that lead |
| PUT | `/instantly` | `{instantly_campaign_id: "<id or link>" \| null}` (people only) |
| POST | `/instantly/push` | `{what?: steps \| leads \| steps_and_leads, note?}` → pending request, nothing sent |
| POST | `/instantly/requests/:id/cancel` | withdraw a pending request |
