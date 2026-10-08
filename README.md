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

## Environment variables

Copy `.env.example` to `.env.local` for local work. Never commit real values.

| Variable | Required | What it is |
|---|---|---|
| `INSTANTLY_API_KEY` | yes | Instantly API v2 key. Create it in Instantly → Settings → Integrations → API Keys, with read-only scopes (`all:read` is enough). Server-only; never prefix it with `NEXT_PUBLIC_`. Without it the dashboard shows a "not connected" state instead of numbers. |
| `DASHBOARD_TZ` | no | IANA timezone that defines "a day" for date ranges and daily charts. Default `America/New_York`. |
| `ALLOWED_USER_EMAIL` | yes | The one email allowed to sign in. Unset = nobody gets in. |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL (login only). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase anon (public) key (login only). |
| `DASHBOARD_DEV_NO_AUTH` | no | Local development only: `1` skips the login so you can run the app without Supabase. Ignored in production builds and on every Vercel deployment. |

## Run it locally

Requires Node 20+ and npm.

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
