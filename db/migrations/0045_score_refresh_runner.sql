-- Phase 2 review fix B (#74, Oct 11, 2026): make the nightly score_refresh job actually run.
--
-- 0030 seeded score_refresh with kind 'score_refresh', but the OVH runner has no
-- handler file by that name (runner/handlers/), so every run was skipped as
-- "unknown job kind". Point it at the generic ops_call handler instead, calling
-- recompute_scores (which now commits in batches of 250 leads) with summary: true
-- so the run log stores counts, not one row per lead. The Settings -> Scoring
-- "Recompute all" button now queues this job instead of running inline.
--
-- Add-only and idempotent: touches only the seeded row, and only while it still
-- has the original kind (a row someone already re-pointed is left alone).
update lp.jobs
   set kind = 'ops_call',
       payload = '{"op": "recompute_scores", "args": {"summary": true}}'::jsonb
 where name = 'score_refresh'
   and kind = 'score_refresh';
