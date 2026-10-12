-- Phase 2, P2-A (plan 2.12): normalise the daily segment-snapshot job to UTC.
--
-- This migration does NOT introduce the job. Migration 0033_traits.sql already
-- seeded lp.jobs 'segment_snapshot' (kind ops_call, '0 7 * * *', timezone
-- 'America/New_York', payload {"op":"segment_snapshot"}, enabled, timeout_s 600
-- by column default, next_run_at NULL). The op it calls is defined in
-- lib/segments/ops.ts: one lp.segment_snapshots row per live segment per day (the
-- unique (segment_id, taken_on) index makes a same-day re-run a no-op), then
-- checkSegmentAlerts. Picking ONE authority for the schedule: every other nightly
-- job (0028 instantly_reconcile, 0053 trigger_scan) is pinned to UTC, and the
-- 07:00 slot is meant to be ~2-3am Eastern, so this makes segment_snapshot
-- '0 7 * * *' in UTC, payload {"op":"segment_snapshot","args":{}}, timeout_s 600,
-- enabled.
--
-- Three things this does, each safe to run twice:
--
-- 1. UPDATE, only when the row is still exactly what 0033 seeded (kind, description,
--    cron, timezone, payload, enabled, timeout_s, campaign_id all equal to 0033's
--    values). Any difference means an operator edited it, and then the row is left
--    alone: a paused job, a different time, a longer timeout all survive. After the
--    update the row no longer matches the 0033 seed, so a second run is a no-op.
--
-- 2. next_run_at is set to the next 07:00 UTC in the same UPDATE. 0033 never set
--    it, and lib/jobs/store.ts claimDueJobs only claims rows with a non-NULL
--    next_run_at (store.ts:192), so the 0033 row has never been picked up by the
--    runner; and a next_run_at computed under America/New_York would be stale
--    after the timezone change. (The same NULL applies to 0028's instantly_reconcile
--    row; that is outside this migration.) Strictly after now(), like cron.ts
--    nextRun, so applying this at exactly 07:00:00 UTC picks tomorrow.
--
-- 3. INSERT if the row is missing (on conflict do nothing). lp.jobs has no
--    soft-delete column (0016): a job is removed with a real DELETE (see 0037), so
--    "missing" cannot be told apart from "never seeded". On a database migrated in
--    order 0033 always ran first, so this branch only fires when someone deleted
--    the job before this migration was applied; re-creating it once then is
--    acceptable (the migration runs once per database, and the owner can delete or
--    disable it afterwards without it coming back).
--
-- args: the runner treats a payload with no "args" and one with "args": {}
-- identically. runner/handlers/ops_call.mjs:12 computes
-- `args = (payload.args && typeof payload.args === 'object') ? payload.args : {}`
-- and line 14 passes that to ctx.ops(op, args); the segment_snapshot op takes no
-- arguments at all (lib/segments/ops.ts, `args: '{}'`). So writing "args": {} only
-- makes the payload explicit.

with slot as (
  select (
    date_trunc('day', now() at time zone 'UTC') + interval '7 hours'
    + case when (now() at time zone 'UTC')::time >= time '07:00' then interval '1 day' else interval '0' end
  ) at time zone 'UTC' as next_at
)
update lp.jobs j
   set timezone      = 'UTC',
       schedule_cron = '0 7 * * *',
       payload       = '{"op": "segment_snapshot", "args": {}}'::jsonb,
       timeout_s     = 600,
       enabled       = true,
       next_run_at   = slot.next_at
  from slot
 where j.name = 'segment_snapshot'
   and j.kind = 'ops_call'
   and j.description = 'Writes today''s size snapshot for every live segment (2.12).'
   and j.schedule_cron = '0 7 * * *'
   and j.timezone = 'America/New_York'
   and j.payload = '{"op": "segment_snapshot"}'::jsonb
   and j.enabled
   and j.timeout_s = 600
   and j.campaign_id is null;

insert into lp.jobs (name, kind, description, schedule_cron, timezone, payload, enabled, timeout_s, next_run_at, created_by)
values (
  'segment_snapshot',
  'ops_call',
  'Writes today''s size snapshot for every live segment (2.12).',
  '0 7 * * *',
  'UTC',
  '{"op": "segment_snapshot", "args": {}}'::jsonb,
  true,
  600,
  (
    date_trunc('day', now() at time zone 'UTC') + interval '7 hours'
    + case when (now() at time zone 'UTC')::time >= time '07:00' then interval '1 day' else interval '0' end
  ) at time zone 'UTC',
  'system'
)
on conflict (name) do nothing;
