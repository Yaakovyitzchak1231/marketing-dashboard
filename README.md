# Marketing dashboard

Instantly campaign metrics for one account. Every figure on the page comes from a stored Supabase row. If Instantly did not report a metric, the page shows it as unavailable. It does not show `0` for a missing value, and it does not invent a rate.

## Live

Production: https://marketing-dashboard-xi-five.vercel.app

Vercel project `marketing-dashboard` on team `yaakovyitzchak1231's projects` (hobby). Do not upgrade the plan.

Production is deployment `dpl_3odzWgAYk2htLwSJAAFiP8nvqsWN`, commit `ccced4e`. QA passed on `280974b`, which this commit contains. `main` is behind it. Do not push `main` and expect it to become production, and do not point the production branch at `main` unless you also deploy the commit you mean to ship.

Checked 2026-09-30, unauthenticated:

- `GET /` → 307 to `/login`
- `GET /login` → 200, email and password fields
- `GET /api/overview` → 401 `{"error":"Unauthorized"}`
- `GET /api/campaigns` → 401 `{"error":"Unauthorized"}`

Those API responses do not include campaign rows.

Signed in, the same day, the page showed 8 campaigns. That matches `select count(*) from campaigns`. The overview figures matched the `accounts` row: 45,545 sent, 1,910 human replies, 174 bounces, 1,335 opportunities, opportunity value 1335000. Open rate and unsubscribes rendered as not reported. `open_rate` and `unsubscribe` are null in `daily_metrics`.

`GET /api/campaigns/22961f82-4e5c-4be1-a576-aff39eab493f/trend?range=30d` returned 500. The page shows the error sentence for the trend. It does not draw a chart from a failed response.

Git pushes from this private repo can land as `BLOCKED` (Vercel hobby account-collaboration). A blocked git deployment is not a production release. The live deployment above was a redeploy of `ccced4e`, not a push to `main`.

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
