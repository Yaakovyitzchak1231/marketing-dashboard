-- 0012: email steps per campaign, a per-lead preview, and a link to an Instantly campaign.
--
--   lp.campaign_steps               ordered email steps of one campaign: subject and body with
--                                   {{field}} placeholders, wait (days) before the step, and a
--                                   variant label (A/B copies of the same step share step_number).
--   lp.campaigns.instantly_*        the Instantly campaign this dashboard campaign is linked to.
--                                   Linking stores an id only; nothing is sent.
--   lp.campaign_instantly_requests  "push these steps / Ready leads to Instantly": a pending request
--                                   that only a human can approve. This migration adds no code path
--                                   that calls Instantly; the human approval flow (PR #46, Needs your
--                                   OK) is the only door that ever sends.
--
-- Merge order: 0010 (rule sets) -> 0011 (campaigns, campaign_leads) -> 0012 (this).
-- lp.campaigns and lp.campaign_leads are created by 0011. The two "create table if not
-- exists" below are a minimal stand-in so this file also applies on its own (tests, or
-- if 0011 has not merged yet); once 0011 has run they do nothing.

create table if not exists lp.campaigns (
  id           bigint generated always as identity primary key,
  name         text not null,
  pool         text not null default 'jeweler',
  rule_set_id  bigint,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists lp.campaign_leads (
  campaign_id  bigint not null references lp.campaigns(id) on delete cascade,
  company_id   bigint not null references lp.companies(id) on delete cascade,
  contact_id   bigint references lp.contacts(id) on delete set null,
  overrides    jsonb not null default '{}'::jsonb,
  added_at     timestamptz not null default now(),
  primary key (campaign_id, company_id)
);

-- ---------------------------------------------------------------- Instantly link (an id only)
alter table lp.campaigns add column if not exists instantly_campaign_id text;
alter table lp.campaigns add column if not exists instantly_linked_at   timestamptz;
alter table lp.campaigns add column if not exists instantly_linked_by   text references lp.actors(id);
-- One dashboard campaign per Instantly campaign, so the upload knows whose rules to use.
create unique index if not exists campaigns_instantly_uq on lp.campaigns (instantly_campaign_id) where instantly_campaign_id is not null;

-- ---------------------------------------------------------------- steps
create table if not exists lp.campaign_steps (
  id           bigint generated always as identity primary key,
  campaign_id  bigint not null references lp.campaigns(id) on delete cascade,
  step_number  integer not null check (step_number between 1 and 1000),  -- app allows 1-50; reorder parks rows at +500 for a moment
  variant      text not null default 'A' check (variant ~ '^[A-Za-z0-9][A-Za-z0-9 _-]{0,19}$'),
  subject      text not null default '' check (length(subject) <= 300),
  body         text not null default '' check (length(body) <= 10000),
  delay_days   integer not null default 0 check (delay_days between 0 and 365),
  created_by   text references lp.actors(id),
  updated_by   text references lp.actors(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists campaign_steps_uq on lp.campaign_steps (campaign_id, step_number, lower(variant));
create index if not exists campaign_steps_campaign_idx on lp.campaign_steps (campaign_id, step_number);
drop trigger if exists campaign_steps_updated on lp.campaign_steps;
create trigger campaign_steps_updated before update on lp.campaign_steps for each row execute function lp.touch_updated_at();

-- ---------------------------------------------------------------- push requests (human OK only)
create table if not exists lp.campaign_instantly_requests (
  id                     bigint generated always as identity primary key,
  campaign_id            bigint not null references lp.campaigns(id) on delete cascade,
  instantly_campaign_id  text not null,
  what                   text not null check (what in ('steps', 'leads', 'steps_and_leads')),
  payload                jsonb not null default '{}'::jsonb,   -- snapshot: steps, Ready lead count, sample
  note                   text,
  status                 text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  approval_id            bigint,                               -- the Needs-your-OK row, once wired (PR #46)
  requested_by           text not null references lp.actors(id),
  decided_by             text references lp.actors(id),
  decided_at             timestamptz,
  decision_note          text,
  created_at             timestamptz not null default now()
);
create index if not exists campaign_instantly_requests_idx on lp.campaign_instantly_requests (campaign_id, status, created_at desc);

-- Only a human decides a push request (an agent can ask, never approve).
create or replace function lp.campaign_push_decided_by_human() returns trigger language plpgsql as $$
begin
  if new.status in ('approved', 'rejected')
     and (new.decided_by is null or not exists (select 1 from lp.actors h where h.id = new.decided_by and h.kind = 'human')) then
    raise exception 'only a human can approve or reject an Instantly push (decided_by = %)', new.decided_by;
  end if;
  return new;
end $$;
drop trigger if exists campaign_push_human on lp.campaign_instantly_requests;
create trigger campaign_push_human before insert or update on lp.campaign_instantly_requests
  for each row execute function lp.campaign_push_decided_by_human();
