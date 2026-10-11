-- Phase 2, P2-H (Oct 11, 2026): segments as campaign sources and exclusions
-- (plan 2.6), on top of the segment engine (migration 0024).
--
--   lp.campaigns.source_segment_id   the segment this campaign's leads were
--                                    last pulled from through campaign_add_
--                                    from_segment (lib/segments/campaign-
--                                    sources.ts), or null if it has none.
--   lp.campaigns.source_sync         'once' (a one-time pull, the default) or
--                                    'keep_syncing' (re-running the op adds any
--                                    new segment members; it is always safe to
--                                    re-run -- already-added leads are a no-op).
--   lp.campaigns.exclude_segment_ids members of any of these segments are never
--                                    added by campaign_add_from_segment, even if
--                                    they also match source_segment_id (e.g. a
--                                    "customers" or "competitors" segment).
alter table lp.campaigns add column if not exists source_segment_id bigint references lp.segments(id) on delete set null;
alter table lp.campaigns add column if not exists source_sync text not null default 'once' check (source_sync in ('once', 'keep_syncing'));
alter table lp.campaigns add column if not exists exclude_segment_ids bigint[] not null default '{}';

create index if not exists campaigns_source_segment_idx on lp.campaigns (source_segment_id) where source_segment_id is not null;
