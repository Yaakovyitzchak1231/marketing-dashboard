-- Lead platform, Phase 1. Plain, portable PostgreSQL (13+).
--
-- Everything lives in its own schema, `lp`, so it can sit beside the legacy
-- tables in the existing Supabase project today and move to any other Postgres
-- (e.g. the OVH server) tomorrow with pg_dump -n lp. No Supabase-only features:
-- no auth.*, no RLS policies, no extensions. Writes go through the dashboard's
-- server (route handlers), never from a browser with a public key.
--
-- One database = one source of truth: leads, research, verification, campaign
-- events, tasks, locks, comments, memory and the activity log all live here.

create schema if not exists lp;

-- ---------------------------------------------------------------------------
-- Who acts: humans and agents are both actors.
-- ---------------------------------------------------------------------------
create table lp.actors (
  id            text primary key check (id ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
  kind          text not null check (kind in ('human', 'agent')),
  display_name  text not null,
  harness       text,                      -- 'tab', 'hermes', 'claude', 'manus', 'instantly', 'dashboard'...
  can_send      boolean not null default false, -- may this actor perform outward sends after approval?
  active        boolean not null default true,
  status_note   text,                      -- free text "what I'm doing" shown on the board
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);

insert into lp.actors (id, kind, display_name, harness) values
  ('owner',       'human', 'Yaakov',        'dashboard'),
  ('tab',         'agent', 'Tab',           'tab'),
  ('hermes',      'agent', 'Hermes',        'hermes'),
  ('claude',      'agent', 'Claude',        'claude'),
  ('manus',       'agent', 'Manus',         'manus'),
  ('instantly-ai','agent', 'Instantly AI',  'instantly'),
  ('system',      'agent', 'Dashboard (built-in jobs)', 'dashboard')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Leads: a company (the store) with zero or more contacts (email addresses).
-- ---------------------------------------------------------------------------
create table lp.companies (
  id               bigint generated always as identity primary key,
  name             text not null,
  segment          text not null default 'jeweler' check (segment in ('jeweler', 'ai_agency', 'other')),
  vertical         text,                    -- 'jewelry', 'bridal', 'watch', ... as the sheet had it
  website          text,
  website_domain   text,                    -- normalized: lowercase host, no www., no path
  phone            text,
  phone_e164       text,                    -- +15551234567
  address_line     text,
  city             text,
  state            text,                    -- 2-letter for US
  postal_code      text,
  country          text not null default 'US',
  name_addr_key    text,                    -- normalized name|address|city|state
  owner_name       text,
  stage            text not null default 'new' check (stage in (
                     'new', 'researched', 'ready', 'in_campaign', 'contacted',
                     'replied', 'interested', 'meeting', 'won', 'lost', 'do_not_contact')),
  research_status  text not null default 'needs_research' check (research_status in (
                     'needs_research', 'queued', 'researching', 'researched', 'failed', 'skipped')),
  last_researched_at timestamptz,
  notes            text,
  created_by       text references lp.actors(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- Dedupe rules: one company per website domain, per phone, per name+address.
create unique index companies_domain_uq   on lp.companies (website_domain) where website_domain is not null;
create unique index companies_phone_uq    on lp.companies (phone_e164)     where phone_e164 is not null;
create unique index companies_nameaddr_uq on lp.companies (name_addr_key)  where name_addr_key is not null;
create index companies_stage_idx    on lp.companies (stage);
create index companies_state_idx    on lp.companies (state);
create index companies_research_idx on lp.companies (research_status);

create table lp.contacts (
  id                    bigint generated always as identity primary key,
  company_id            bigint references lp.companies(id) on delete cascade,
  email                 text,
  email_norm            text,               -- lower(trim(email))
  first_name            text,
  last_name             text,
  suggested_first_name  text,
  title                 text,
  is_role_address       boolean,            -- info@, sales@ ...
  email_source          text,               -- website, facebook, guessed, research, ...
  name_source           text,
  name_confidence       text,
  name_evidence_url     text,
  -- The sheet's status vocabulary, kept so nothing is lost in the move.
  status                text not null default 'new' check (status in (
                          'new', 'verifying', 'valid-ready', 'catch-all-hold', 'guessed-hold',
                          'rejected', 'in-Instantly', 'sent', 'replied', 'bounced', 'do-not-contact')),
  verification_status   text not null default 'unverified' check (verification_status in (
                          'unverified', 'valid', 'invalid', 'catch_all', 'unknown', 'risky')),
  verified_at           timestamptz,
  verified_by           text,               -- provider that decided: precheck/millionverifier/zerobounce/sheet
  personalization       text,
  do_not_contact        boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index contacts_email_uq on lp.contacts (email_norm) where email_norm is not null;
create index contacts_company_idx on lp.contacts (company_id);
create index contacts_verif_idx   on lp.contacts (verification_status);
create index contacts_status_idx  on lp.contacts (status);

-- Where each fact came from (sheet row, map data, a website page, an agent).
create table lp.sources (
  id           bigint generated always as identity primary key,
  company_id   bigint references lp.companies(id) on delete cascade,
  contact_id   bigint references lp.contacts(id) on delete cascade,
  kind         text not null,              -- sheet_import, overture, website, facebook, research, manual
  source_ref   text not null default '',   -- e.g. 'Leads!row 1234' or a batch name
  url          text,
  observed_at  timestamptz not null default now(),
  payload      jsonb
);
create unique index sources_uq on lp.sources (coalesce(company_id, 0), coalesce(contact_id, 0), kind, source_ref);

-- One fact per row: owner name, an email found, POS detected, personalization...
create table lp.enrichment (
  id            bigint generated always as identity primary key,
  company_id    bigint not null references lp.companies(id) on delete cascade,
  contact_id    bigint references lp.contacts(id) on delete set null,
  field         text not null,             -- owner_name, email, phone, pos, tech, personalization, ...
  value         text not null,
  confidence    text check (confidence in ('high', 'medium', 'low')),
  evidence_url  text,
  method        text not null,             -- regex, llm, manual, sheet_import, agent
  actor_id      text references lp.actors(id),
  task_id       bigint,
  created_at    timestamptz not null default now()
);
create unique index enrichment_uq on lp.enrichment (company_id, field, lower(value));

-- Verification history: one row per check per provider.
create table lp.verification_runs (
  id                bigint generated always as identity primary key,
  status            text not null default 'preview' check (status in ('preview', 'approved', 'running', 'done', 'cancelled', 'failed')),
  requested_by      text references lp.actors(id),
  approved_by       text references lp.actors(id),
  contact_ids       bigint[] not null,
  contact_count     integer not null,
  precheck_pass     integer,
  est_mv_checks     integer,
  est_zb_checks     integer,
  est_cost_usd      numeric(10, 4),
  max_cost_usd      numeric(10, 4),       -- the ceiling the human approved
  spent_usd         numeric(10, 4) not null default 0,
  processed         integer not null default 0,
  summary           jsonb,
  created_at        timestamptz not null default now(),
  approved_at       timestamptz,
  finished_at       timestamptz
);

create table lp.verification_results (
  id           bigint generated always as identity primary key,
  contact_id   bigint references lp.contacts(id) on delete cascade,
  email        text not null,
  provider     text not null check (provider in ('precheck', 'millionverifier', 'zerobounce', 'sheet_import', 'manual')),
  result       text not null,              -- provider's own word (ok, catch_all, valid, catch-all, invalid, unknown, no_mx, ...)
  verdict      text not null check (verdict in ('valid', 'invalid', 'catch_all', 'unknown', 'risky', 'pass')),
  sub_result   text,
  cost_usd     numeric(10, 5) not null default 0,
  run_id       bigint references lp.verification_runs(id) on delete set null,
  raw          jsonb,
  checked_at   timestamptz not null default now()
);
create index verification_results_contact_idx on lp.verification_results (contact_id, checked_at desc);

-- Campaign events from Instantly (webhook) and the sheet import.
create table lp.campaign_touches (
  id             bigint generated always as identity primary key,
  contact_id     bigint references lp.contacts(id) on delete set null,
  company_id     bigint references lp.companies(id) on delete set null,
  email          text,
  campaign_id    text,
  campaign_name  text,
  event_type     text not null,           -- email_sent, reply_received, email_bounced, lead_unsubscribed, ...
  occurred_at    timestamptz not null default now(),
  source         text not null,           -- instantly_webhook, sheet_import, manual
  external_id    text,                    -- dedupe key for webhook retries
  payload        jsonb,
  created_at     timestamptz not null default now()
);
create unique index campaign_touches_ext_uq on lp.campaign_touches (source, external_id) where external_id is not null;
create index campaign_touches_contact_idx  on lp.campaign_touches (contact_id, occurred_at desc);
create index campaign_touches_campaign_idx on lp.campaign_touches (campaign_id);

-- Every stage / status change, written by trigger so no writer can skip it.
create table lp.status_history (
  id           bigint generated always as identity primary key,
  entity_type  text not null check (entity_type in ('company', 'contact')),
  entity_id    bigint not null,
  field        text not null,
  old_value    text,
  new_value    text,
  changed_by   text,
  changed_at   timestamptz not null default now()
);
create index status_history_entity_idx on lp.status_history (entity_type, entity_id, changed_at desc);

-- The writer names itself per transaction: set local lp.actor = 'tab';
create or replace function lp.current_actor() returns text language sql stable as $$
  select nullif(current_setting('lp.actor', true), '')
$$;

create or replace function lp.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function lp.log_company_stage() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by)
    values ('company', new.id, 'stage', null, new.stage, lp.current_actor());
  elsif new.stage is distinct from old.stage then
    insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by)
    values ('company', new.id, 'stage', old.stage, new.stage, lp.current_actor());
  end if;
  return new;
end $$;

create or replace function lp.log_contact_status() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by)
    values ('contact', new.id, 'status', null, new.status, lp.current_actor());
  else
    if new.status is distinct from old.status then
      insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by)
      values ('contact', new.id, 'status', old.status, new.status, lp.current_actor());
    end if;
    if new.verification_status is distinct from old.verification_status then
      insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by)
      values ('contact', new.id, 'verification_status', old.verification_status, new.verification_status, lp.current_actor());
    end if;
  end if;
  return new;
end $$;

create trigger companies_updated before update on lp.companies for each row execute function lp.touch_updated_at();
create trigger contacts_updated  before update on lp.contacts  for each row execute function lp.touch_updated_at();
create trigger companies_stage_log after insert or update of stage on lp.companies for each row execute function lp.log_company_stage();
create trigger contacts_status_log after insert or update of status, verification_status on lp.contacts for each row execute function lp.log_contact_status();

-- ---------------------------------------------------------------------------
-- Co-working: tasks, locks, comments, approvals, memory, and the activity log.
-- Humans and agents use the same tables through the same API.
-- ---------------------------------------------------------------------------
-- Projects group tasks, like a team workspace: humans and agents are teammates.
create table lp.projects (
  id           bigint generated always as identity primary key,
  name         text not null unique,
  description  text,
  status       text not null default 'active' check (status in ('active', 'paused', 'done', 'archived')),
  lead_actor   text references lp.actors(id),
  created_by   text references lp.actors(id),
  created_at   timestamptz not null default now()
);
insert into lp.projects (name, description, lead_actor, created_by) values
  ('Lead research', 'Research stores for owner names and emails', 'tab', 'system'),
  ('Verification', 'Free check, MillionVerifier, then ZeroBounce for catch-all/unknown', 'tab', 'system'),
  ('Reply desk', 'Replies, bounces and unsubscribes from Instantly', 'owner', 'system')
on conflict (name) do nothing;

create table lp.tasks (
  id                bigint generated always as identity primary key,
  project_id        bigint references lp.projects(id) on delete set null,
  kind              text not null,          -- research_company, verify_contacts, review_reply, general, ...
  title             text not null,
  status            text not null default 'queued' check (status in (
                      'queued', 'claimed', 'running', 'blocked', 'needs_approval', 'done', 'failed', 'cancelled')),
  priority          integer not null default 0,
  assigned_to       text references lp.actors(id),   -- null = anyone who can do this kind may claim it
  claimed_by        text references lp.actors(id),
  lease_expires_at  timestamptz,
  heartbeat_at      timestamptz,
  attempts          integer not null default 0,
  max_attempts      integer not null default 3,
  company_id        bigint references lp.companies(id) on delete set null,
  payload           jsonb not null default '{}'::jsonb,
  result            jsonb,
  report            text,                   -- the claimer's plain-English report
  handoff_note      text,
  error             text,
  dedupe_key        text,
  created_by        text references lp.actors(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  finished_at       timestamptz
);
-- At most one live task per dedupe key (e.g. one research job per company).
create unique index tasks_dedupe_live_uq on lp.tasks (dedupe_key)
  where dedupe_key is not null and status in ('queued', 'claimed', 'running', 'blocked', 'needs_approval');
create index tasks_queue_idx on lp.tasks (status, kind, priority desc, id);
create index tasks_project_idx on lp.tasks (project_id);
create index tasks_claimed_idx on lp.tasks (claimed_by) where claimed_by is not null;
create trigger tasks_updated before update on lp.tasks for each row execute function lp.touch_updated_at();

-- "Checked out like a library book": one holder per resource, with a lease.
create table lp.locks (
  resource          text primary key,       -- 'campaign:<id>', 'company:<id>', 'list:<name>'
  holder            text not null references lp.actors(id),
  task_id           bigint references lp.tasks(id) on delete set null,
  note              text,
  acquired_at       timestamptz not null default now(),
  heartbeat_at      timestamptz not null default now(),
  lease_expires_at  timestamptz not null
);

create table lp.comments (
  id           bigint generated always as identity primary key,
  task_id      bigint references lp.tasks(id) on delete cascade,
  company_id   bigint references lp.companies(id) on delete cascade,
  author       text not null references lp.actors(id),
  body         text not null check (length(body) between 1 and 20000),
  kind         text not null default 'comment' check (kind in ('comment', 'handoff', 'report', 'system')),
  mentions     text[] not null default '{}',  -- actor ids @mentioned in the body
  created_at   timestamptz not null default now(),
  check (task_id is not null or company_id is not null)
);
create index comments_task_idx    on lp.comments (task_id, created_at);
create index comments_company_idx on lp.comments (company_id, created_at);

-- What each teammate (human or agent) should look at: @mentions, assignments, handoffs.
create table lp.notifications (
  id           bigint generated always as identity primary key,
  recipient    text not null references lp.actors(id),
  kind         text not null check (kind in ('mention', 'assigned', 'handoff', 'approval', 'task_update')),
  summary      text not null,
  task_id      bigint references lp.tasks(id) on delete cascade,
  comment_id   bigint references lp.comments(id) on delete cascade,
  created_by   text references lp.actors(id),
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);
create index notifications_inbox_idx on lp.notifications (recipient, read_at, created_at desc);

-- Approve-before-send: anything outward or paid waits here for a human.
create table lp.approvals (
  id            bigint generated always as identity primary key,
  action        text not null check (action in ('send', 'spend', 'destructive', 'other')),
  summary       text not null,
  payload       jsonb not null default '{}'::jsonb,
  est_cost_usd  numeric(10, 4),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  requested_by  text not null references lp.actors(id),
  decided_by    text references lp.actors(id),
  decision_note text,
  task_id       bigint references lp.tasks(id) on delete set null,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  expires_at    timestamptz
);
create index approvals_status_idx on lp.approvals (status, created_at desc);

-- Per-agent memory (scope = the agent's id), plus a 'shared' scope everyone reads.
create table lp.agent_memory (
  id          bigint generated always as identity primary key,
  scope       text not null,                -- an actor id, or 'shared'
  key         text not null check (length(key) between 1 and 200),
  notes       text not null,
  source      text,                         -- where the agent learned it
  updated_by  text references lp.actors(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (scope, key)
);
create trigger agent_memory_updated before update on lp.agent_memory for each row execute function lp.touch_updated_at();

-- The activity log: append-only. Plain-English summary for the feed, data for machines.
create table lp.events (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor        text references lp.actors(id),
  kind         text not null,               -- task.claimed, lock.acquired, verify.run, webhook.reply_received, memory.put ...
  summary      text not null,
  entity_type  text,
  entity_id    text,
  task_id      bigint,
  data         jsonb
);
create index events_at_idx on lp.events (at desc);
create index events_entity_idx on lp.events (entity_type, entity_id, at desc);

create or replace function lp.events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'lp.events is append-only';
end $$;
create trigger events_no_update before update or delete on lp.events for each row execute function lp.events_append_only();
