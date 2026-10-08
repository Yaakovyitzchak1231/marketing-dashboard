# Marketing Dashboard

A private dashboard for Instantly.ai cold-email campaigns: live numbers for any
date range, correct rates, and plain-language "what to do next" callouts —
which campaigns, steps and subject lines get replies, which sending inboxes are
bouncing, and which replied leads are still waiting on you.

Next.js 15 (App Router) · TypeScript (strict) · Tailwind · deployed on Vercel.

## How it works

```
browser ──login (Supabase email + password)──▶ middleware.ts (allow-list gate)
   │
   └─▶ Next.js server ──Bearer INSTANTLY_API_KEY──▶ Instantly API v2
            │                                        (https://api.instantly.ai/api/v2)
            ├─ lib/instantly/   read-only client: pagination, retries, ~5 min cache
            ├─ lib/dashboard/   one typed DashboardData per date range (types.ts is the contract)
            ├─ lib/insights/    ranked "what to do next" callouts computed from that data
            └─ app/ + components/  renders it; /api/dashboard serves the same JSON
```

- **Live data, server-side only.** The Next.js server calls Instantly directly.
  The API key never reaches the browser. Responses are cached for about five
  minutes (Next `fetch` revalidation), so the page is fast and Instantly's rate
  limits are respected; numbers are at most a few minutes old.
- **Read-only.** The dashboard only reads from Instantly. It never creates,
  edits, pauses or sends anything.
- **Honest numbers.** `null` means "Instantly didn't report it" and is shown as
  unavailable (for example open rate when open tracking is off); `0` is a
  measured zero. Rates are recomputed from raw counts, never averaged.
- **Supabase is only the login.** Sign-in uses Supabase Auth, and only the
  account in `ALLOWED_USER_EMAIL` gets in. Every page and every API route,
  including `/api/dashboard`, is behind that gate, and it fails closed: missing
  config, an auth outage or a different account all mean no access.

### Legacy (no longer in the data path)

- `collector/` — the old Python collector that pulled Instantly through
  Composio into Supabase on an OVH server. The dashboard no longer reads its
  output; it can be switched off once the new version is live.
- `supabase/migrations/`, `scripts/backfill_revisions.sql`, `docs/` — schema
  and notes for that old Supabase data model. Kept for reference only. The
  Supabase project itself is still needed for the login.

## Lead platform

Leads, research, verification, campaign events and teamwork between you and the agents
now live in one Postgres schema (`lp`), with screens for each job: Overview, Leads,
Find leads, Verification, Campaigns, Replies, Team, Agents, Activity.

How the agents work together, in one paragraph: everyone (you, Tab, Hermes, Claude,
Manus) uses the same Team board. An agent picks up a task and keeps checking in; if it
goes quiet the task frees itself. Before changing a campaign or list it "checks it out"
like a library book, so two agents never touch the same thing. `@tab` in a note lands in
Tab's inbox. Anything outward or paid waits for your Approve click. Every action shows
up in the Activity feed, and each agent's memory is readable and editable on its page.

### How agents and people work together, step by step

1. **One board.** Every job is a task on the Team board. The assignee can be you or an
   agent (Tab, Hermes, Claude, Manus). Anyone can create, comment, hand off or close a task.
2. **Claim and check in.** An agent claims a task before working on it and sends a
   heartbeat every few minutes. If it goes quiet, its claim runs out and the task is free
   for someone else. Nobody works on a task someone else holds.
3. **Check out before changing.** Before touching a campaign, a lead list or a lead, an
   agent takes a lock on it (like a library book). Others see who has it and wait.
   Instantly's own AI can't take locks, so its campaigns count as checked out to it.
4. **Your Approve click for anything outward or paid.** Sends, paid verification runs and
   anything destructive wait in the Activity feed until you approve. Reading, research and
   drafts don't need you.
5. **One feed.** Every claim, lock, change, comment and approval is written to the
   Activity feed in plain English, so you can always see who did what.
6. **Memory per agent.** Each agent has its own notes on its Agents page; you can read and
   edit them. Tab's page is where you assign Tab work and read its reports.
7. **One source of truth.** All of it lives in one Postgres schema (`lp`). The Lead Master
   Google Sheet is imported once and becomes a read-only export.

Details, the ops API and the import: [docs/LEAD_PLATFORM.md](docs/LEAD_PLATFORM.md).
How the lead engine (Find leads) works, how to run it on your server and its limits:
[docs/lead-engine.md](docs/lead-engine.md).

## Environment variables

Copy `.env.example` to `.env.local` for local work. Never commit real values.

| Variable | Required | What it is |
|---|---|---|
| `INSTANTLY_API_KEY` | yes | Instantly API v2 key. Create it in Instantly → Settings → Integrations → API Keys, with read-only scopes (`all:read` is enough). Server-only; never prefix it with `NEXT_PUBLIC_`. Without it the dashboard shows a "not connected" state instead of numbers. |
| `DASHBOARD_TZ` | no | IANA timezone that defines "a day" for date ranges and daily charts. Default `America/New_York`. |
| `ALLOWED_USER_EMAIL` | yes | The one email allowed to sign in. Unset = nobody gets in. |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL (login only). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase anon (public) key (login only). |
| `DATABASE_URL` | for the lead platform | Postgres connection string for the `lp` schema (Supabase: use the pooler URL; or the OVH server). Unset = the lead screens show "not connected" and the Instantly pages still work. |
| `OPS_AGENT_TOKENS` | for agents | `tab:<token>,hermes:<token>,...` — one long random token per agent for the ops API. |
| `INSTANTLY_WEBHOOK_SECRET` | for the reply desk | Shared secret Instantly sends on each webhook (`Authorization: Bearer <secret>`), 16+ characters. |
| `MILLIONVERIFIER_API_KEY` | for paid verification | MillionVerifier API key. Used only after you approve a run's cost preview. |
| `ZEROBOUNCE_API_KEY` | for paid verification | ZeroBounce API key. Used only for MillionVerifier catch-all/unknown results, after approval. |
| `ENGINE_PROXIES` | runner only | On the server that runs the lead engine: comma-separated proxy URLs, used only when a job ticks "Rotate proxies". Not needed on Vercel. |
| `SEARXNG_URL` | runner only, optional | Free self-hosted search used by the owner-name step. Without it (or `SERPER_API_KEY`) the search steps are skipped. |
| `SERPER_API_KEY` | runner only, optional | Paid search alternative to SearXNG. Leave unset to stay free. |
| `OPS_URL`, `OPS_TOKEN` | runner only | Where an agent runner reaches the ops API (the dashboard URL + `/api/ops`) and that agent's token from `OPS_AGENT_TOKENS`. |
| `DASHBOARD_DEV_NO_AUTH` | no | Local development only: `1` skips the login so you can run the app without Supabase. Ignored in production builds and on every Vercel deployment. |

## Run it locally

Requires Node 22+ and npm (Supabase's client needs Node 22's built-in WebSocket).

```bash
npm ci
cp .env.example .env.local   # fill in INSTANTLY_API_KEY, ALLOWED_USER_EMAIL, Supabase values
npm run dev                  # http://localhost:3000
```

No Supabase project handy? `DASHBOARD_DEV_NO_AUTH=1 npm run dev` skips the
login locally (development server only).

### Checks

| Command | What it runs |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (`next/core-web-vitals` + `next/typescript`); fails on errors |
| `npm run lint:strict` | same, but warnings fail too |
| `npm test` | Vitest, once (`npm run test:watch` to watch) |
| `npm run check` | typecheck + lint + test — run this before opening a PR |
| `npm run build` | production build |

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, typecheck, lint,
tests and a production build on every pull request and on pushes to `main`.

## Deploy on Vercel

The project is already linked to Vercel (production:
https://marketing-dashboard-xi-five.vercel.app). To ship this version:

1. **Add the Instantly key.** Vercel → the `marketing-dashboard` project →
   Settings → Environment Variables → Add:
   - Key `INSTANTLY_API_KEY`, value = your Instantly API key,
     environments **Production** and **Preview**. Mark it Sensitive.
   - Optional: `DASHBOARD_TZ` = `America/New_York` (or your timezone).
2. **Check the login variables** are still set for Production and Preview:
   `ALLOWED_USER_EMAIL`, `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Do **not** set `DASHBOARD_DEV_NO_AUTH` on
   Vercel (it is ignored there anyway).
3. **Redeploy.** Environment changes apply to new deployments only: Deployments
   → the latest one → ⋯ → Redeploy (or merge the PR, which deploys `main`).
4. **Verify.** Open the site, sign in, and pick 7d / 30d / 90d — the totals
   should change with the range and match Instantly's own Analytics page for
   the same dates.

Vercel installs with npm (`package-lock.json`; there is no other lockfile) and
builds with `next build`. No `vercel.json` is needed.

## Metrics, defined


All rates are 0–100 %, recomputed from raw counts for the selected date range
(days in `DASHBOARD_TZ`). A rate shows as "—" when its denominator is zero or
Instantly didn't report the inputs.

| Metric | Formula |
|---|---|
| Reply rate | replied leads ÷ leads contacted |
| Positive reply rate | positive (interested) leads ÷ leads contacted |
| Positive share of replies | positive leads ÷ replied leads |
| Bounce rate | bounced ÷ emails sent |
| Open rate | unique opens ÷ leads contacted (unavailable when open tracking is off) |
| Click rate | unique clicks ÷ leads contacted |

Where each count comes from (Instantly API v2, `GET /campaigns/analytics` and `/campaigns/analytics/overview`, called with the range's `start_date`/`end_date`):

| Count | Instantly field | Why |
|---|---|---|
| Emails sent | `emails_sent_count` | every email, all steps |
| Leads contacted | `new_leads_contacted_count` | distinct people. `contacted_count` is NOT used: it equals sends |
| Replied | `reply_count_unique` | distinct leads who replied; Instantly reports auto-replies separately, so nothing is subtracted |
| Auto-replies | `reply_count_automatic_unique` | out-of-office etc., shown on their own |
| Positive | `total_opportunities` | leads marked interested / opportunities in Instantly |
| Meetings booked | `total_meeting_booked` (overview only) | |
| Bounced | `bounced_count` | |
| Opens / clicks | `open_count_unique` / `link_click_count_unique` | only when tracking is on; otherwise "tracking off", never 0% |

Daily chart: `GET /campaigns/analytics/daily` (days Instantly omits are real zeros). Steps and subject lines: `GET /campaigns/analytics/steps` + the campaign's sequence. Sending accounts: `GET /accounts` + `GET /accounts/analytics/daily` (per-inbox sent/bounced/replied). Replies waiting on you: `GET /emails` (latest email of each reply thread) + `POST /leads/list` (read-only lookup of interest status).

The insights engine's rules and thresholds are documented in [docs/INSIGHTS.md](docs/INSIGHTS.md).
| Unsubscribe rate | unsubscribes ÷ leads contacted |
| Step / variant reply rate | replies to that step+variant ÷ emails sent for it |
