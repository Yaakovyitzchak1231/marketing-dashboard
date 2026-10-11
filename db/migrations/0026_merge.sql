-- Phase 2, P2-C (plan 1.9): duplicate detection & merge.
--
--   lp.merge_log        one row per merge: entity, kept_id, merged_id, the field
--                        choices applied, who did it, when. Never deleted.
--   companies/contacts   get merged_into: a soft delete. A merged row keeps its
--                        id and data (it is the tombstone) but is hidden from
--                        every list/query (lib/leads/queries.ts) and freed from
--                        the unique dedupe indexes, so the surviving row can
--                        hold the domain/phone/key/email going forward.
--
-- Candidates are found by recomputing lib/leads/normalize.ts against the raw
-- fields live (not by trusting the stored website_domain/phone_e164/name_addr_key/
-- email_norm columns, which can drift from the current normalizer or from data
-- written outside the app) -- see lib/merge/candidates.ts.

alter table lp.companies add column if not exists merged_into bigint references lp.companies(id);
alter table lp.companies add constraint companies_not_self_merge check (merged_into is null or merged_into <> id);
create index if not exists companies_merged_into_idx on lp.companies (merged_into) where merged_into is not null;

alter table lp.contacts add column if not exists merged_into bigint references lp.contacts(id);
alter table lp.contacts add constraint contacts_not_self_merge check (merged_into is null or merged_into <> id);
create index if not exists contacts_merged_into_idx on lp.contacts (merged_into) where merged_into is not null;

-- Free the dedupe keys of a merged (soft-deleted) row, so the kept row -- or a
-- brand new one -- can use the same domain/phone/key/email going forward.
drop index if exists lp.companies_domain_uq;
create unique index companies_domain_uq on lp.companies (website_domain) where website_domain is not null and merged_into is null;
drop index if exists lp.companies_phone_uq;
create unique index companies_phone_uq on lp.companies (phone_e164) where phone_e164 is not null and merged_into is null;
drop index if exists lp.companies_nameaddr_uq;
create unique index companies_nameaddr_uq on lp.companies (name_addr_key) where name_addr_key is not null and merged_into is null;
drop index if exists lp.contacts_email_uq;
create unique index contacts_email_uq on lp.contacts (email_norm) where email_norm is not null and merged_into is null;

create table if not exists lp.merge_log (
  id             bigint generated always as identity primary key,
  entity         text not null check (entity in ('company', 'contact')),
  kept_id        bigint not null,
  merged_id      bigint not null,
  field_choices  jsonb not null default '{}'::jsonb check (jsonb_typeof(field_choices) = 'object'),
  actor          text references lp.actors(id),
  at             timestamptz not null default now()
);
create index if not exists merge_log_kept_idx on lp.merge_log (entity, kept_id, at desc);
create index if not exists merge_log_merged_idx on lp.merge_log (entity, merged_id);
