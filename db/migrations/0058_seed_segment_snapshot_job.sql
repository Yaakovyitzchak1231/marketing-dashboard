-- Phase 2, P2-A (plan 2.12): seed the daily segment-snapshot job.
--
-- lib/segments/ops.ts already defines the 'segment_snapshot' op -- it loops
-- every live segment, writes one lp.segment_snapshots row per segment for
-- today (the unique (segment_id, taken_on) index makes a same-day re-run a
-- no-op, never a duplicate), and then calls checkSegmentAlerts so a segment
-- with alert_rule set is evaluated against its two most recent snapshots.
-- That op has been hand-callable since PR #82; this row is the "future runner"
-- migration 0024's comment refers to -- it wires that op into the nightly
-- schedule the same way 0028 wires instantly_reconcile in.
--
-- One row, ops_call kind, daily at 07:00 UTC (same slot as instantly_reconcile,
-- ~2-3am Eastern, after the day's sends are done and before the morning).
-- Enabled on purpose: it is read-only against Instantly (this op is read-only
-- against the lead tables too -- one insert into segment_snapshots plus a
-- possible notification per alerted segment), so it is safe to ship on.
insert into lp.jobs (name, kind, description, schedule_cron, timezone, payload, enabled, timeout_s)
values (
  'segment_snapshot',
  'ops_call',
  'Daily snapshot of every segment size for plan 2.12 (lp.segment_snapshots) + alert check (lib/segments/alerts.ts).',
  '0 7 * * *',
  'UTC',
  '{"op": "segment_snapshot", "args": {}}',
  true,
  600
)
on conflict (name) do nothing;
