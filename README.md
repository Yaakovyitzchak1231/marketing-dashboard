# Marketing dashboard

Instantly campaign metrics for one account. Every figure on the page comes from a stored Supabase row. If Instantly did not report a metric, the page shows it as unavailable. It does not show `0` for a missing value, and it does not invent a rate.

## Live

Production: https://marketing-dashboard-xi-five.vercel.app

Vercel project `marketing-dashboard` on team `yaakovyitzchak1231's projects` (hobby). Do not upgrade the plan.

The production deployment is commit `280974b` (`integrate/all`). QA passed on that commit. `main` is behind it. Do not push `main` and expect it to become production, and do not point the production branch at `main` unless you also deploy the commit you mean to ship.

Checked 2026-09-30, unauthenticated:

- `GET /` → 307 to `/login`
- `GET /login` → 200
- `GET /api/overview` → 401 `{"error":"Unauthorized"}`
- `GET /api/campaigns` → 401 `{"error":"Unauthorized"}`

Those API responses do not include campaign rows.

Git pushes from this private repo currently create deployments in state `BLOCKED` (Vercel hobby account-collaboration). The live deployment was not produced by a git push. A blocked git deployment must not be treated as a new production release.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set the same names in the Vercel project for Production. Never commit a filled env file, and never put a key in a remote URL or a commit message.

| Name | Where it is used |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Browser and server. Project `zlbxjdueuhinywnovyoe`. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser. Public client key. Still do not commit it. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Not stored in this repo. Must not appear in the client bundle. |
| `ALLOWED_USER_EMAIL` | Middleware allow-list. The code default is a placeholder (`jacob@example.com`). Production overrides it. One address only. |

`COMPOSIO_API_KEY` and `INSTANTLY_ACCOUNT` are collector settings. The Next.js app does not call Instantly.

## Auth

Unauthenticated page requests redirect to `/login`. Unauthenticated API requests return 401 and no data. A session whose email is not the allow-listed address is rejected.

The deployment at `280974b` signs in with a magic link (`signInWithOtp`). Supabase's built-in SMTP does not reliably deliver that mail, so that sign-in cannot be finished from this host. Do not weaken the 401 to work around it.

## Refresh

Collection stays on the OVH VM. Do not move it to Vercel. The hobby plan has no useful cron for this job.

What actually runs every 30 minutes:

- Hermes cron `3961f696b606` ("Marketing dashboard data refresh") on the `mkt-data` profile.
- Script: `/home/hermes/.hermes/profiles/mkt-data/scripts/marketing_dashboard_refresh.py`
- That script runs the prototype collector at `/home/hermes/.hermes/profiles/mkt-data/workspace/marketing-dashboard/collect_instantly.py`.
- That collector writes local JSON (`dashboard.json` and a history file). It does not upsert this app's Supabase tables.

This app reads Supabase (`campaigns`, `daily_metrics`, `accounts`), not those JSON files.

The ported collector is `collector/collect_instantly.py` in this repo. It upserts into Supabase and is meant to run on the VM, not on Vercel. It is not on the 30-minute cron. A one-shot load left 8 campaign rows, 8 daily-metric rows, and 1 account row, latest metric date `2026-09-30`. Until the VM cron runs this collector, a new Instantly pull does not show up here by itself.

Leave the 30-minute job where it is. The Tailscale service `marketing-dashboard.service` (port 8901) is the old prototype, not this app.

## Checks

```bash
npm run test
npm run lint
npm run typecheck
npm run build
```
