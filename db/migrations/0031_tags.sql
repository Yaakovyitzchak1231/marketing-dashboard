-- Phase 2, slice P2-F part 2 (Oct 11, 2026): tags as first-class (plan 2.9).
--
-- lp.companies.tags is already text[] (migration 0011). This adds the metadata
-- tags need to be a real feature instead of free-floating strings:
--
--   lp.tag_defs  one row per tag that has ever been given a colour or description
--                (a tag used only as plain text in companies.tags still "exists" for
--                counting purposes; a row here is optional until someone styles it).
--
-- Renaming or merging tags (lib/tags/store.ts) updates every lp.companies row that
-- carries the old tag, is written to the universal audit log (lp.status_history,
-- entity_type 'tag', entity_key = the tag name), and emits tag_removed/tag_added
-- lead events per affected lead (tag_added / tag_removed already exist as event
-- types since migration 0018).

create table if not exists lp.tag_defs (
  tag         text primary key check (length(tag) between 1 and 60),
  colour      text check (colour is null or colour ~ '^#[0-9a-fA-F]{6}$'),
  description text check (description is null or length(description) <= 500),
  created_by  text references lp.actors(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists tag_defs_updated on lp.tag_defs;
create trigger tag_defs_updated before update on lp.tag_defs for each row execute function lp.touch_updated_at();

-- Add 'tag' to the audit-log entity-type whitelist (drop + re-add with the full
-- list, same as 0030_scoring.sql did for 'score_model').
alter table lp.status_history drop constraint if exists status_history_entity_type_check;
alter table lp.status_history add constraint status_history_entity_type_check
  check (entity_type in ('company', 'contact', 'task', 'campaign', 'campaign_lead', 'campaign_profile',
                         'actor', 'setting', 'suppression', 'job', 'pool', 'integration', 'event_type',
                         'deal', 'segment', 'journey', 'score_model', 'tag'));

-- Seed lp.tag_defs with every tag already in use (in companies.tags) that has no
-- row yet, uncoloured, so the tag manager's count-per-tag works immediately on
-- data that predates this migration.
insert into lp.tag_defs (tag)
select distinct t from lp.companies c, unnest(c.tags) as t
where t is not null and length(t) between 1 and 60
on conflict (tag) do nothing;
