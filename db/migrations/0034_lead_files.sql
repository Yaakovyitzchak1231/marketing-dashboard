-- Phase 2, P2-J (Oct 11, 2026): file links for the full lead profile (plan 2.10).
--
--   lp.files   one row per file/document LINK attached to a lead (company, and
--              optionally one of its contacts). Links only -- no paid storage:
--              `url` points at wherever the file actually lives (Drive, Dropbox,
--              a public URL the agent already has). Add/remove goes through
--              lib/leads/files.ts (addLeadFile / removeLeadFile), audited in the
--              universal log (lp.status_history, entity_type 'file').
--
-- Canonical audit-log entity_type list (added 12:17 PM, see PHASE2_COMMON.md):
-- several parallel Phase 2 migrations alter lp.status_history's entity_type
-- check constraint, and whichever runs LAST in filename order wins. This file
-- uses the exact canonical superset so it doesn't silently drop a sibling
-- migration's type.
alter table lp.status_history drop constraint if exists status_history_entity_type_check;
alter table lp.status_history add constraint status_history_entity_type_check
  check (entity_type in ('company', 'contact', 'task', 'campaign', 'campaign_lead', 'campaign_profile',
                         'actor', 'setting', 'suppression', 'job', 'pool', 'integration', 'event_type',
                         'deal', 'segment', 'journey', 'field_def', 'merge', 'retention_policy', 'score_model',
                         'tag', 'trait', 'file', 'team_member'));

create table if not exists lp.files (
  id           bigint generated always as identity primary key,
  company_id   bigint not null references lp.companies(id) on delete cascade,
  contact_id   bigint references lp.contacts(id) on delete set null,
  name         text not null check (length(name) between 1 and 200),
  url          text not null check (length(url) between 1 and 2000),
  note         text check (note is null or length(note) <= 1000),
  uploaded_by  text references lp.actors(id),
  created_at   timestamptz not null default now()
);
create index if not exists files_company_idx on lp.files (company_id, created_at desc);
create index if not exists files_contact_idx on lp.files (contact_id) where contact_id is not null;
