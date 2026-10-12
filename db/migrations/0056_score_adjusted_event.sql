-- 0056: the score_adjusted lead event type, for the adjust_score audit trail.
--
-- Add-only: inserts into lp.event_types (on conflict do nothing); no schema
-- change, no existing rows touched. lib/scoring/engine.ts adjustScore emits
-- one of these per manual adjustment (who, when, how much, why,
-- before/after), so the adjustment is visible in the lead's event timeline
-- and queryable by segments, like every other lead event.

insert into lp.event_types (key, label, category, source) values
  ('score_adjusted', 'Score adjusted', 'signal', 'dashboard')
on conflict (key) do nothing;
