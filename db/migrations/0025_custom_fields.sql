-- Phase 2 (Oct 11, 2026), plan 1.7 + 1.13: custom fields, and import/manual-add/phone-only contacts.
--
-- lp.field_defs lets Yaakov define his own fields on a company or a contact (store
-- size, Google rating, ring brands carried, last trade show, ...) without a code
-- change. Values live in companies.custom / contacts.custom (jsonb, keyed by the
-- field's slug) so the column list never grows. campaign_id is purely a display
-- filter ("only show this field when working a lead in this campaign"); the jsonb
-- key itself is shared across campaigns, so a field's key is unique per entity
-- regardless of campaign_id.
--
-- 1.13 (depends on 1.7): a contact with a phone and no email is now allowed (for
-- call-only leads) -- added NOT VALID so it never scans/locks the existing table.

create table if not exists lp.field_defs (
  id          bigint generated always as identity primary key,
  entity      text not null check (entity in ('company', 'contact')),
  key         text not null check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  label       text not null check (length(label) between 1 and 80),
  type        text not null check (type in ('text', 'number', 'date', 'select', 'multi_select', 'url', 'boolean')),
  options     jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  campaign_id bigint references lp.campaigns(id) on delete set null,
  sort        integer not null default 100,
  archived_at timestamptz,
  created_by  text references lp.actors(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- One live (non-archived) key per entity; an archived field's key can be reused.
create unique index if not exists field_defs_live_key_uq on lp.field_defs (entity, key) where archived_at is null;
create index if not exists field_defs_entity_idx on lp.field_defs (entity, sort) where archived_at is null;
create index if not exists field_defs_campaign_idx on lp.field_defs (campaign_id) where campaign_id is not null;

drop trigger if exists field_defs_updated on lp.field_defs;
create trigger field_defs_updated before update on lp.field_defs for each row execute function lp.touch_updated_at();

alter table lp.companies add column if not exists custom jsonb not null default '{}'::jsonb check (jsonb_typeof(custom) = 'object');
alter table lp.contacts  add column if not exists custom jsonb not null default '{}'::jsonb check (jsonb_typeof(custom) = 'object');
create index if not exists companies_custom_gin on lp.companies using gin (custom);
create index if not exists contacts_custom_gin  on lp.contacts  using gin (custom);

-- Custom-field definition changes (define/update/archive) are audited too, keyed
-- by the field's own id (entity_type 'field_def'); add it to the status_history
-- whitelist alongside the existing entity types.
-- Canonical superset list per the Phase 2 orchestrator's cross-builder rule (every
-- parallel PR that drops/re-adds this constraint must use EXACTLY this list, in this
-- order, so whichever migration applies last does not silently drop another PR's type).
alter table lp.status_history drop constraint if exists status_history_entity_type_check;
alter table lp.status_history add constraint status_history_entity_type_check
  check (entity_type in ('company', 'contact', 'task', 'campaign', 'campaign_lead', 'campaign_profile',
                         'actor', 'setting', 'suppression', 'job', 'pool', 'integration', 'event_type',
                         'deal', 'segment', 'journey', 'field_def', 'merge', 'retention_policy',
                         'score_model', 'tag', 'trait', 'file', 'team_member'));

-- 1.13: phone-only contacts (for call tasks). NOT VALID so it never locks/scans
-- the existing table; new and updated rows are checked going forward, and a
-- background VALIDATE CONSTRAINT can tighten it later once any stray rows (there
-- should be none -- email was already effectively required by the app) are seen.
alter table lp.contacts drop constraint if exists contacts_email_or_phone_chk;
alter table lp.contacts add constraint contacts_email_or_phone_chk
  check (email is not null or phone is not null) not valid;
