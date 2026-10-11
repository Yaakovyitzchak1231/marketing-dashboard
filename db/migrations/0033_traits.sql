-- Phase 2, P2-I (Oct 11, 2026): computed traits (plan 2.7) and segment
-- analytics / size-over-time (plan 2.12), on top of the segment engine
-- (migration 0024, PR #77).
--
--   lp.traits         one row per defined trait: key (the slug a segment
--                     condition, score rule or the builder names it by),
--                     label, which entity it's computed per, its definition
--                     jsonb (event type(s), aggregation, window, prop filters
--                     -- lib/traits/definition.ts validates this shape),
--                     last_computed_at (null = never run; the dirty-set
--                     incremental recompute's watermark).
--   lp.trait_values    one row per entity per trait: the computed number,
--                     refreshed by the 'traits_refresh' runner job. Read
--                     through a scalar subquery the segment field registry
--                     registers per trait (lib/segments/fields.ts
--                     registerTraitField, wired in lib/traits/register.ts),
--                     so "replies_30d > 0" works as a segment condition with
--                     no change to the compiler.
--
-- Segment alerts (2.12): lp.segments gets one small jsonb column for an
-- optional growth/shrink threshold; crossing it writes an ordinary
-- lp.notifications row to 'owner' (lib/ops/core.ts's existing notify()),
-- the same path @mentions and task handoffs already use -- no new delivery
-- channel, no mail sender.
--
-- Two shared check constraints move to the Phase 2 canonical superset here
-- (PHASE2_COMMON.md's "Audit-log entity types" section): status_history's
-- entity_type (adding 'trait', among others already reserved for sibling
-- slices) and notifications.kind (adding 'segment_alert'). Both use
-- drop-then-add, so whichever Phase 2 migration runs last (filename order)
-- must carry the full list -- this file uses exactly the common brief's
-- canonical list for entity_type.

alter table lp.status_history drop constraint if exists status_history_entity_type_check;
alter table lp.status_history add constraint status_history_entity_type_check
  check (entity_type in ('company', 'contact', 'task', 'campaign', 'campaign_lead', 'campaign_profile',
                         'actor', 'setting', 'suppression', 'job', 'pool', 'integration', 'event_type',
                         'deal', 'segment', 'journey', 'field_def', 'merge', 'retention_policy',
                         'score_model', 'tag', 'trait', 'file', 'team_member'));

alter table lp.notifications drop constraint if exists notifications_kind_check;
alter table lp.notifications add constraint notifications_kind_check
  check (kind in ('mention', 'assigned', 'handoff', 'approval', 'task_update', 'message', 'segment_alert'));

create table if not exists lp.traits (
  key               text primary key check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  label             text not null check (length(label) between 1 and 80),
  entity            text not null check (entity in ('company', 'contact')),
  definition        jsonb not null check (jsonb_typeof(definition) = 'object'),
  archived_at       timestamptz,
  last_computed_at  timestamptz,                 -- null = never run (treated as "all dirty")
  created_by        text references lp.actors(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists traits_live_idx on lp.traits (archived_at) where archived_at is null;
drop trigger if exists traits_updated on lp.traits;
create trigger traits_updated before update on lp.traits for each row execute function lp.touch_updated_at();

create table if not exists lp.trait_values (
  id           bigint generated always as identity primary key,
  trait_key    text not null references lp.traits(key) on delete cascade,
  company_id   bigint references lp.companies(id) on delete cascade,
  contact_id   bigint references lp.contacts(id) on delete cascade,
  value        numeric,                          -- null = computed, answer unset (never 0)
  computed_at  timestamptz not null default now(),
  check ((company_id is not null) <> (contact_id is not null))   -- exactly one of company or contact
);
create unique index if not exists trait_values_company_uq on lp.trait_values (trait_key, company_id) where company_id is not null;
create unique index if not exists trait_values_contact_uq on lp.trait_values (trait_key, contact_id) where contact_id is not null;
create index if not exists trait_values_company_idx on lp.trait_values (company_id) where company_id is not null;
create index if not exists trait_values_contact_idx on lp.trait_values (contact_id) where contact_id is not null;

-- 2.12: an optional per-segment growth/shrink alert. Shape:
--   {"enabled": true, "shrink_pct": 20, "grow_pct": 50}
-- -- "tell me if this segment's company count drops more than 20% or grows more
-- than 50% versus its previous snapshot". Null / {} = no alert configured.
alter table lp.segments add column if not exists alert_rule jsonb check (alert_rule is null or jsonb_typeof(alert_rule) = 'object');
alter table lp.segments add column if not exists last_alerted_on date;  -- which day's snapshot last fired an alert (fire-once guard)

-- Five campaign-agnostic starter traits (2.7's seed list). on conflict do nothing: a
-- redeploy, or a dashboard user who already renamed/redefined one of these keys, is a
-- no-op here, not a silent overwrite of what they changed.
insert into lp.traits (key, label, entity, definition, created_by) values
  ('replies_30d', 'Replies (30d)', 'company',
   '{"event_types":["reply_received"],"aggregation":"count","prop":null,"window_days":30,"prop_filters":[]}'::jsonb, 'system'),
  ('opens_14d', 'Opens (14d)', 'company',
   '{"event_types":["email_opened"],"aggregation":"count","prop":null,"window_days":14,"prop_filters":[]}'::jsonb, 'system'),
  ('days_since_last_touch', 'Days since last touch', 'company',
   '{"event_types":["email_sent","email_opened","email_link_clicked","reply_received"],"aggregation":"days_since","prop":null,"window_days":null,"prop_filters":[]}'::jsonb, 'system'),
  ('steps_received', 'Sequence steps received', 'company',
   '{"event_types":["email_sent"],"aggregation":"count","prop":null,"window_days":null,"prop_filters":[]}'::jsonb, 'system'),
  ('total_meetings', 'Total meetings booked', 'company',
   '{"event_types":["meeting_booked"],"aggregation":"count","prop":null,"window_days":null,"prop_filters":[]}'::jsonb, 'system')
on conflict (key) do nothing;

-- Runner jobs (lib/jobs/store.ts; the generic 'ops_call' handler, runner/handlers/ops_call.mjs,
-- is all either needs -- no new handler file). 'system' is the built-in dashboard/jobs actor
-- (migration 0001).
insert into lp.jobs (name, kind, description, schedule_cron, timezone, payload, created_by) values
  ('traits_refresh', 'ops_call', 'Recomputes every active trait''s values for entities with new events (2.7).',
   '0 * * * *', 'America/New_York', '{"op":"recompute_traits"}'::jsonb, 'system'),
  ('segment_snapshot', 'ops_call', 'Writes today''s size snapshot for every live segment (2.12).',
   '0 7 * * *', 'America/New_York', '{"op":"segment_snapshot"}'::jsonb, 'system')
on conflict (name) do nothing;
