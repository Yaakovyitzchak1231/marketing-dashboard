-- Phase 1 foundation, part 3 (Oct 10, 2026): the lead event stream.
--
--   lp.event_types  the registry of event types (key, label, category, source).
--                   An event type must be registered before lp.lead_events can
--                   carry it, so agents can add their own types without a deploy.
--   lp.lead_events  one row per thing that happened to a lead: email sent, opened,
--                   replied, bounced, unsubscribed, stage changed, verified,
--                   custom events from agents. Segments, journeys, scoring and
--                   analytics all read this one table. Append-only.
--
-- lp.events stays the activity/audit feed (who did what in the dashboard);
-- lp.campaign_touches stays the raw Instantly webhook record. The webhook now also
-- writes a lead_events row in the same transaction (lib/webhooks/instantly.ts).
--
-- campaign_id is the dashboard campaign (lp.campaigns); instantly_campaign_id is
-- Instantly's own id, kept as text, because a touch can arrive for an Instantly
-- campaign that has no dashboard campaign yet.

create table if not exists lp.event_types (
  key           text primary key check (key ~ '^[a-z][a-z0-9_.]{0,63}$'),
  label         text not null check (length(label) between 1 and 80),
  category      text not null check (category in ('email', 'lifecycle', 'verification', 'web', 'social', 'meeting', 'deal', 'signal', 'custom')),
  source        text not null default 'system',   -- instantly, warmbly, dashboard, agent, site, runner ...
  props_schema  jsonb,                             -- optional JSON-schema-ish description of props
  active        boolean not null default true,
  created_by    text references lp.actors(id),
  created_at    timestamptz not null default now()
);

insert into lp.event_types (key, label, category, source) values
  ('email_sent',           'Email sent',            'email',        'instantly'),
  ('email_opened',         'Email opened',          'email',        'instantly'),
  ('email_link_clicked',   'Link clicked',          'email',        'instantly'),
  ('reply_received',       'Reply received',        'email',        'instantly'),
  ('auto_reply_received',  'Auto-reply received',   'email',        'instantly'),
  ('email_bounced',        'Email bounced',         'email',        'instantly'),
  ('lead_unsubscribed',    'Unsubscribed',          'email',        'instantly'),
  ('lead_interested',      'Marked interested',     'email',        'instantly'),
  ('lead_not_interested',  'Marked not interested', 'email',        'instantly'),
  ('meeting_booked',       'Meeting booked',        'meeting',      'instantly'),
  ('campaign_completed',   'Sequence completed',    'email',        'instantly'),
  ('stage_changed',        'Stage changed',         'lifecycle',    'dashboard'),
  ('status_changed',       'Contact status changed','lifecycle',    'dashboard'),
  ('field_changed',        'Field edited',          'lifecycle',    'dashboard'),
  ('tag_added',            'Tag added',             'lifecycle',    'dashboard'),
  ('tag_removed',          'Tag removed',           'lifecycle',    'dashboard'),
  ('added_to_campaign',    'Added to campaign',     'lifecycle',    'dashboard'),
  ('pushed_to_instantly',  'Pushed to Instantly',   'email',        'dashboard'),
  ('suppressed',           'Suppressed',            'lifecycle',    'dashboard'),
  ('verified',             'Email verified',        'verification', 'dashboard'),
  ('custom',               'Custom event',          'custom',       'agent')
on conflict (key) do nothing;

create table if not exists lp.lead_events (
  id                     bigint generated always as identity primary key,
  occurred_at            timestamptz not null default now(),
  recorded_at            timestamptz not null default now(),
  type                   text not null references lp.event_types(key),
  company_id             bigint references lp.companies(id) on delete set null,
  contact_id             bigint references lp.contacts(id) on delete set null,
  email_norm             text,                     -- kept so an event survives a contact merge/delete
  campaign_id            bigint references lp.campaigns(id) on delete set null,
  instantly_campaign_id  text,
  step                   integer,                  -- sequence step, when the source says
  source                 text not null,            -- instantly_webhook, ops_api, dashboard, runner, backfill ...
  actor                  text references lp.actors(id),
  props                  jsonb not null default '{}'::jsonb check (jsonb_typeof(props) = 'object'),
  dedupe_key             text                      -- e.g. 'touch:<campaign_touches.id>' or the sender's event id
);
create unique index if not exists lead_events_dedupe_uq on lp.lead_events (dedupe_key) where dedupe_key is not null;
create index if not exists lead_events_company_idx  on lp.lead_events (company_id, occurred_at desc);
create index if not exists lead_events_contact_idx  on lp.lead_events (contact_id, occurred_at desc);
create index if not exists lead_events_type_idx     on lp.lead_events (type, occurred_at desc);
create index if not exists lead_events_campaign_idx on lp.lead_events (campaign_id, occurred_at desc) where campaign_id is not null;
create index if not exists lead_events_occurred_idx on lp.lead_events (occurred_at desc);

-- Append-only. Rows pointing at a deleted company/contact/campaign keep their
-- history: the FK's "on delete set null" is an UPDATE, so allow exactly that change.
create or replace function lp.lead_events_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and new.id = old.id and new.type = old.type and new.occurred_at = old.occurred_at
     and new.props = old.props and new.source = old.source
     and new.dedupe_key is not distinct from old.dedupe_key
     and (new.company_id is null or new.company_id = old.company_id)
     and (new.contact_id is null or new.contact_id = old.contact_id)
     and (new.campaign_id is null or new.campaign_id = old.campaign_id) then
    return new;
  end if;
  raise exception 'lp.lead_events is append-only';
end $$;
drop trigger if exists lead_events_no_update on lp.lead_events;
create trigger lead_events_no_update before update or delete on lp.lead_events
  for each row execute function lp.lead_events_append_only();

-- Lifecycle events from the audit log: a company stage or contact status change
-- becomes a lead event too, so segments and journeys see it without each writer
-- remembering to emit one.
create or replace function lp.lead_event_from_history() returns trigger language plpgsql as $$
begin
  if new.entity_type = 'company' and new.field = 'stage' and new.old_value is not null then
    insert into lp.lead_events (type, company_id, source, actor, props, occurred_at)
    values ('stage_changed', new.entity_id, 'trigger',
            (select id from lp.actors where id = new.changed_by),
            jsonb_build_object('from', new.old_value, 'to', new.new_value, 'history_id', new.id), new.changed_at);
  elsif new.entity_type = 'contact' and new.field = 'status' and new.old_value is not null then
    insert into lp.lead_events (type, contact_id, company_id, email_norm, source, actor, props, occurred_at)
    select 'status_changed', c.id, c.company_id, c.email_norm, 'trigger',
           (select id from lp.actors where id = new.changed_by),
           jsonb_build_object('from', new.old_value, 'to', new.new_value, 'history_id', new.id), new.changed_at
      from lp.contacts c where c.id = new.entity_id;
  end if;
  return new;
end $$;
drop trigger if exists status_history_lead_event on lp.status_history;
create trigger status_history_lead_event after insert on lp.status_history
  for each row execute function lp.lead_event_from_history();

-- Backfill: every stored Instantly touch becomes a lead event (dedupe on the touch
-- id, so re-running this file adds nothing). Event types Instantly sent that are
-- not in the registry are registered as 'email' events first, so nothing is lost.
insert into lp.event_types (key, label, category, source)
select distinct t.event_type, initcap(replace(t.event_type, '_', ' ')), 'email', 'instantly'
  from lp.campaign_touches t
 where t.event_type ~ '^[a-z][a-z0-9_.]{0,63}$'
on conflict (key) do nothing;

insert into lp.lead_events (occurred_at, type, company_id, contact_id, email_norm, instantly_campaign_id,
                            source, props, dedupe_key)
select t.occurred_at, t.event_type, t.company_id, t.contact_id, lower(trim(t.email)), t.campaign_id,
       'backfill', jsonb_build_object('touch_source', t.source, 'campaign_name', t.campaign_name),
       'touch:' || t.id
  from lp.campaign_touches t
 where t.event_type ~ '^[a-z][a-z0-9_.]{0,63}$'
on conflict do nothing;
