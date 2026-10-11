# The background job runner — NOT DEPLOYED, waiting for Yaakov's OK

A small, zero-dependency Node service that runs scheduled and on-demand jobs for the dashboard:
sending the weekly digest, polling a tools-hub integration, pinging a URL, or (later) a per-campaign
news monitor. It is designed to run on Yaakov's OVH server, next to Hermes and Warmbly, but **this PR
ships code and this note only — nothing has been installed or started anywhere.**

```
dashboard (Vercel, Postgres)                     OVH server (Yaakov's box)
┌─────────────────────────┐                      ┌───────────────────────────┐
│ lp.jobs, lp.job_runs     │  POST /api/ops       │ runner/index.mjs           │
│ (the schedule, the log)  │ <─────────────────── │  - polls every N seconds   │
│ lib/jobs/store.ts        │  {op:'claim_jobs'}   │  - claim_jobs              │
│  FOR UPDATE SKIP LOCKED  │ ───────────────────> │  - runs the matching       │
│                          │  {jobs claimed}      │    handler under a timeout │
│                          │  {op:'finish_job_   │  - finish_job_run          │
│                          │   run', ...}         │  - never touches Postgres  │
└─────────────────────────┘                      └───────────────────────────┘
```

**Why the ops API, not Postgres directly:** the house rule is "the DB is the single source of truth;
agents use the API, each with its own key." The runner authenticates as actor `system` with its own
bearer key (minted on `/agents`, like any other agent), and the claim SQL (`FOR UPDATE SKIP LOCKED`)
lives server-side in `lib/jobs/store.ts` — the runner never holds a database credential.

## What's in this PR

- `lib/jobs/cron.ts` — a small, dependency-free 5-field cron parser (`*`, lists, ranges, steps, names)
  with `nextRun(expr, from, timezone)`, DST-correct via `Intl` (no external cron library).
- `lib/jobs/store.ts` — `upsertJob`, `listJobs`, `setEnabled`, `runNow`, `claimDueJobs` (the
  `FOR UPDATE SKIP LOCKED` claim, one transaction, inserts the `lp.job_runs` row), `finishRun`
  (closes the run, reschedules from cron, clears the lock, writes an `lp.events` `job.finished` row),
  `reapStale` (marks a run whose lock expired as `timeout`).
- `lib/jobs/ops.ts` (`JOB_OPS`, one spread line in `lib/ops/dispatch.ts`) — `list_jobs`, `get_job`,
  `put_job` (owner/system), `set_job_enabled` (owner/system), `run_job_now` (owner/system),
  `claim_jobs` (system only), `finish_job_run` (system only), `reap_stale_jobs` (owner/system),
  `job_runs`.
- `runner/index.mjs` (env + poll loop) + `runner/lib.mjs` (testable logic: `makeOps`, `runOne`,
  `pollOnce` — same split as `ops/hermes-relay/{relay.mjs,lib.mjs}`) + `runner/handlers/` — the
  standalone runner. `runner/handlers/index.mjs`
  auto-registers every `*.mjs` file in that directory (each exports `{ kind, handle(ctx) }`) — adding a
  new job kind is one new file, nothing else to wire up. Shipped handlers: `heartbeat` (records ok with
  a timestamp — the simplest possible end-to-end test job), `http_ping` (payload `{url}`, checks the
  status), `ops_call` (payload `{op, args}` — calls one ops API op; this is how a later per-campaign
  job like `instantly_reconcile` or a news/tools-hub poller runs without its own handler file). A
  handler's `ctx` is `{ campaignId, payload, signal, ops(op, args), log(line) }`; `signal` fires when
  the job's `timeout_s` elapses. An unknown `kind` finishes as `skipped` with a clear error. The runner
  never logs `RUNNER_KEY` or anything the dashboard sends back that looks like a secret.
- `app/jobs/page.tsx` + `app/actions/jobs.ts` — a table of jobs (name, kind, campaign, schedule in
  words + next run, last run status/time, enable/disable, Run now), an add-job form, and recent runs
  with errors. One nav line in `components/nav/AppNav.tsx`.
- `ops/runner/tapdash-runner.service` + `ops/runner/env.example` (below).

## Deploying it (when Yaakov says go — not done yet)

On the dashboard, as Yaakov:
1. `/agents` → create (or reuse) the `system` agent → **API keys** → *Create a key* (label "OVH
   runner"). Copy it; it is shown once. This is `RUNNER_KEY` below — it is the runner's own
   credential and is never shared with any other agent.
2. Add your first job on `/jobs` (e.g. name `nightly-heartbeat`, kind `heartbeat`, schedule
   `0 2 * * *`, timezone `America/New_York`) so there is something for the runner to pick up on its
   first poll.

On the OVH server, as the `hermes` user (no sudo needed — same pattern as `ops/hermes-relay/`):
```bash
mkdir -p ~/tapdash-runner/handlers ~/.config/systemd/user
# copy runner/index.mjs and runner/lib.mjs -> ~/tapdash-runner/
# copy runner/handlers/*.mjs -> ~/tapdash-runner/handlers/
# copy ops/runner/tapdash-runner.service -> ~/.config/systemd/user/

cp ops/runner/env.example ~/.config/tapdash-runner.env
chmod 600 ~/.config/tapdash-runner.env
nano ~/.config/tapdash-runner.env       # paste DASHBOARD_URL and RUNNER_KEY

systemctl --user daemon-reload
systemctl --user enable --now tapdash-runner
journalctl --user -u tapdash-runner -f  # expect "runner ... starting, polling every 15s against ..."
```
`loginctl enable-linger hermes` should already be in place for Hermes' other user services (check
with `loginctl show-user hermes | grep Linger`); if not, `loginctl enable-linger hermes` once, as root
or with sudo, so the runner keeps running after the SSH session ends.

**Test:** create a `heartbeat` job with `schedule_cron: "* * * * *"` (every minute) on `/jobs`, wait
up to a minute, and watch `/jobs` show a run with status `ok`. Then switch its schedule to something
real and disable or delete the test job.

### Resource footprint (estimate)
- Node process, idle polling: well under 50 MB RSS, effectively 0% CPU between polls (one HTTPS
  request every `POLL_SECONDS`).
- Each job run's footprint is the handler's own (a `heartbeat` run is instant; an `http_ping` or
  `ops_call` run is one outbound HTTPS request plus whatever that op does server-side — the runner
  process itself stays light regardless).
- No local storage, no local port opened, no local database. The only new outbound traffic from the
  OVH box is HTTPS to `DASHBOARD_URL`.

### It doesn't touch Hermes or Warmbly
The runner is a brand-new systemd **user** unit (`tapdash-runner`, distinct from Hermes' own
`dashboard-relay` unit from `ops/hermes-relay/`), its own directory (`~/tapdash-runner`), its own env
file, and its own agent key (`system`, not `hermes`). It opens no port, binds nothing, and never calls
anything on `127.0.0.1` or the Tailscale IP — it only calls out to `DASHBOARD_URL` over HTTPS. Nothing
in Hermes' or Warmbly's configuration, containers, or ports is read or changed by installing it.

## Undo
```bash
systemctl --user disable --now tapdash-runner
rm ~/.config/systemd/user/tapdash-runner.service; systemctl --user daemon-reload
rm -rf ~/tapdash-runner ~/.config/tapdash-runner.env
```
Then revoke the key on `/agents` → `system` → API keys. Any job left `enabled` just stops being
picked up (a stale `locked_until` self-clears via `reap_stale_jobs`, callable from `/jobs` or on a
schedule of its own).

## Design notes / anything needing Yaakov's decision
- `reap_stale_jobs` is an op, not yet its own scheduled job — nothing currently calls it
  automatically. Easiest fix once this runner is live: add a `reap-stale-jobs` job of kind
  `ops_call` with `payload: {"op":"reap_stale_jobs"}` on a short schedule (e.g. every 5 minutes).
- A failed run still reschedules on its own cron (one bad run doesn't silently stop a recurring job
  forever); `/jobs` surfaces failures so they're visible, not silent.
- Running two runner processes against the same dashboard (e.g. for redundancy) is safe as shipped —
  `FOR UPDATE SKIP LOCKED` means they never claim the same job — but is not needed yet with one box.
