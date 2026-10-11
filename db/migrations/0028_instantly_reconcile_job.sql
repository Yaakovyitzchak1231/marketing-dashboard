-- Phase 2, slice P2-D (plan 1.6): seed the nightly Instantly reconcile job.
--
-- lib/jobs/* already defines the job-runner schema (0016_settings_jobs.sql);
-- this just adds the one row so the OVH runner picks it up once this
-- migration applies (next production deploy -- previews never migrate, per
-- the house rule, so nothing runs against a preview database).
--
-- schedule_cron is UTC (lp.jobs.timezone default is America/New_York, so this
-- job is pinned to UTC explicitly): 07:00 UTC is ~2-3am Eastern, after the
-- day's sends are done and before Yaakov's morning. Disabled isn't an option
-- here on purpose: it does nothing destructive (read-only Instantly calls,
-- idempotent inserts), so it's safe to ship enabled.
insert into lp.jobs (name, kind, description, schedule_cron, timezone, enabled, timeout_s)
values (
  'instantly_reconcile',
  'instantly_reconcile',
  'Nightly catch-up: pulls per-lead Instantly activity (lib/instantly/reconcile.ts) and fills in any lp.lead_events the live webhook missed.',
  '0 7 * * *',
  'UTC',
  true,
  600
)
on conflict (name) do nothing;
