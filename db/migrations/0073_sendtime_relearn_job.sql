-- Phase 3, plan 3.11: seed the nightly send-time relearn job.
--
-- Add-only and idempotent: on conflict (name) do nothing. Wires the
-- per-lead send-time optimisation to the job runner: the sendtime_recompute
-- op (lib/sendtime/ops.ts) relearns send windows from the last 90 days of
-- engagement events (lib/sendtime/analyze.ts).
insert into lp.jobs (name, kind, description, schedule_cron, timezone, enabled, timeout_s)
values (
  'sendtime_relearn',
  'sendtime_recompute',
  'Nightly relearn: recomputes per-lead send windows from recent engagement events (lib/sendtime/analyze.ts via the sendtime_recompute op).',
  '0 3 * * *',
  'UTC',
  true,
  900
)
on conflict (name) do nothing;
