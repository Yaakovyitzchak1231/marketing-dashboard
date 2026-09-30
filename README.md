# Marketing dashboard

Instantly campaign metrics for one account. Every figure on the page comes from a stored Supabase row. If Instantly did not report a metric, the page shows it as unavailable. It does not show `0` for a missing value, and it does not invent a rate.

## Live

Production: https://marketing-dashboard-xi-five.vercel.app

Vercel project `marketing-dashboard` on team `yaakovyitzchak1231's projects` (hobby). Do not upgrade the plan.

Production is deployment `dpl_HEByDdoHYB2VJ7XCkiJKrW6u6Hsg`, commit `cd9b916` on `task/t10-deploy`. That commit is `ccced4e` plus the trend order fix (`20c9988`) and the unreliable-rate copy fix (`ea6c446`). QA passed on `280974b`, which this commit contains. Do not push `main` and expect it to become production.

Checked 2026-09-30 after that deploy, unauthenticated:

- `GET /` → 307 to `/login`
- `GET /login` → 200, email and password fields
- `GET /api/overview` → 401 `{"error":"Unauthorized"}`
- `GET /api/campaigns` → 401 `{"error":"Unauthorized"}`
- `GET /api/campaigns/22961f82-4e5c-4be1-a576-aff39eab493f/trend?range=30d` → 401

Those bodies do not include campaign rows.

Signed in, the same check, the page is not showing the database:

- `GET /` → 200
- `GET /api/overview?range=7d` → 200, every count `null`
- `GET /api/campaigns?range=7d` → 200, `{"campaigns":[]}`
- the trend URL above → 404 `{"error":"Campaign not found"}`

`select count(*)` still returns 8 campaigns, 8 daily-metric rows, and 1 account, latest metric date `2026-09-30`. RLS is on. SELECT policies exist for `authenticated` only, scoped to `yaakovytroutai@gmail.com`. The live routes still query as the anon role, so PostgREST returns no rows. An empty 200 is not "the account sent nothing."

An earlier signed-in check the same day, before RLS, showed 8 campaigns. Overview matched the accounts row: 45,545 sent, 1,910 human replies, 174 bounces, 1,335 opportunities, opportunity value 1335000. Open rate and unsubscribes were not reported. That check is not the current production response.

Git pushes from this private repo can land as `BLOCKED` (Vercel hobby account-collaboration). A blocked git deployment is not a production release. The live deployment above was created from commit `cd9b916` via the Vercel API, not by pushing `main`.

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
| `ALLOWED_USER_EMAIL` | Middleware allow-list. At `ccced4e` an unset value fails closed (`unset@invalid.local`). Production is set to the one confirmed auth user. One address only. |

`COMPOSIO_API_KEY` and `INSTANTLY_ACCOUNT` are collector settings. The Next.js app does not call Instantly.

## Auth

Unauthenticated page requests redirect to `/login`. Unauthenticated API requests return 401 and no data. A session whose email is not the allow-listed address is rejected.

Sign-in is email and password (`signInWithPassword`). The magic link is gone. The only confirmed auth user is `yaakovytroutai@gmail.com`. The password is in `/home/hermes/.hermes/profiles/leaddesk/secrets/dashboard_login.env` (mode 600). Do not commit it, and do not put it in this file. Do not weaken the 401 to work around a failed sign-in.

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
