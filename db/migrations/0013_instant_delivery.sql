-- 0013: instant delivery. Every "someone needs to know" row (lp.notifications) now fans out to
-- the recipient's own delivery channels the moment it is written, with a status per channel.
--
--   lp.notifications.kind 'message'  direct messages (human <-> agent, agent <-> agent), body kept whole.
--   lp.agent_keys                    API keys per agent, stored as sha256 hashes (the key is shown once).
--                                    OPS_AGENT_TOKENS (Vercel env) keeps working beside them.
--   lp.delivery_channels             how each actor wants to hear: webhook (signed POST), ntfy (a wake-up
--                                    ping to a private topic the agent's relay listens on), email, stream
--                                    (SSE), pull (GET /api/ops/feed), mcp, relay (another agent carries it,
--                                    e.g. Hermes sends Yaakov a WhatsApp).
--   lp.deliveries                    one row per notification x channel: pending -> sent -> delivered,
--                                    held (quiet hours), failed (after retries). "read" is
--                                    lp.notifications.read_at.
--   lp.actors.quiet_shabbos          per person: hold pushes (WhatsApp etc.) from Friday candle lighting
--                                    to Saturday nightfall (Baltimore). On by default for humans.
--
-- A trigger creates the delivery rows in the same transaction as the notification, so no caller
-- can forget, and pg_notify('lp_delivery') fires for any listener (a LISTEN relay can swap in later).

alter table lp.notifications drop constraint if exists notifications_kind_check;
alter table lp.notifications add constraint notifications_kind_check
  check (kind in ('mention', 'assigned', 'handoff', 'approval', 'task_update', 'message'));
alter table lp.notifications add column if not exists body text;

alter table lp.actors add column if not exists quiet_shabbos boolean not null default true;
alter table lp.actors add column if not exists created_by text;

create table if not exists lp.agent_keys (
  id            bigint generated always as identity primary key,
  actor_id      text not null references lp.actors(id) on delete cascade,
  key_hash      text not null unique,          -- sha256 hex of the whole key; the key itself is never stored
  hint          text not null,                 -- last 4 characters, so the UI can tell keys apart
  label         text,
  created_by    text references lp.actors(id),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    text references lp.actors(id)
);
create index if not exists agent_keys_actor_idx on lp.agent_keys (actor_id) where revoked_at is null;

create table if not exists lp.delivery_channels (
  id             bigint generated always as identity primary key,
  actor_id       text not null references lp.actors(id) on delete cascade,
  kind           text not null check (kind in ('webhook', 'ntfy', 'email', 'stream', 'pull', 'mcp', 'relay')),
  label          text,
  -- webhook {url}; ntfy {server, topic}; email {to}; relay {via, target, to}; stream/pull/mcp {}
  config         jsonb not null default '{}'::jsonb,
  secret         text,                         -- webhook signing secret; server-side only, shown once
  enabled        boolean not null default true,
  created_by     text references lp.actors(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_ok_at     timestamptz,
  last_error     text,
  last_error_at  timestamptz
);
create index if not exists delivery_channels_actor_idx on lp.delivery_channels (actor_id) where enabled;

create table if not exists lp.deliveries (
  id               bigint generated always as identity primary key,
  notification_id  bigint not null references lp.notifications(id) on delete cascade,
  channel_id       bigint not null references lp.delivery_channels(id) on delete cascade,
  recipient        text not null references lp.actors(id) on delete cascade,
  via              text references lp.actors(id) on delete set null,  -- relay: the agent that carries it
  status           text not null default 'pending'
                   check (status in ('pending', 'sent', 'delivered', 'held', 'failed', 'skipped')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  sent_at          timestamptz,
  delivered_at     timestamptz,
  failed_at        timestamptz,
  fetched_at       timestamptz,                  -- last time the agent pulled it (feed, stream, MCP)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (notification_id, channel_id)
);
create index if not exists deliveries_due_idx on lp.deliveries (next_attempt_at) where status in ('pending', 'held', 'sent');
create index if not exists deliveries_recipient_idx on lp.deliveries (recipient, id);
create index if not exists deliveries_via_idx on lp.deliveries (via, id) where via is not null;

create or replace function lp.fan_out_notification() returns trigger language plpgsql as $$
begin
  insert into lp.deliveries (notification_id, channel_id, recipient, via)
  select new.id, c.id, new.recipient,
         case when c.kind = 'relay' then nullif(c.config->>'via', '') else null end
    from lp.delivery_channels c
   where c.actor_id = new.recipient and c.enabled
  on conflict do nothing;
  perform pg_notify('lp_delivery', json_build_object('notification_id', new.id, 'recipient', new.recipient)::text);
  return new;
end $$;

drop trigger if exists notifications_fan_out on lp.notifications;
create trigger notifications_fan_out after insert on lp.notifications
  for each row execute function lp.fan_out_notification();

-- One status per notification for the UI: read > delivered > sent > waiting > failed > no channel.
create or replace view lp.notification_delivery as
select n.id as notification_id,
       case
         when n.read_at is not null then 'read'
         when bool_or(d.status = 'delivered') then 'delivered'
         when bool_or(d.status = 'sent') then 'sent'
         when bool_or(d.status = 'held') then 'held'
         when bool_or(d.status = 'pending') then 'pending'
         when count(d.id) > 0 then 'failed'
         else 'no_channel'
       end as status,
       count(d.id)::int as channels,
       max(d.last_error) filter (where d.status = 'failed') as last_error,
       min(d.next_attempt_at) filter (where d.status = 'held') as held_until
  from lp.notifications n
  left join lp.deliveries d on d.notification_id = n.id
 group by n.id, n.read_at;

-- Tab's door is its mailbox: new mail wakes it within seconds. Sending needs MAIL_PROVIDER +
-- MAIL_API_KEY + MAIL_FROM in Vercel; until they are set these deliveries show "failed: mail
-- is not configured" on the task, never silently nothing.
insert into lp.delivery_channels (actor_id, kind, label, config, created_by)
select 'tab', 'email', 'Tab''s mailbox', '{"to": "yaakov-tab@mail.tab.bot"}'::jsonb, 'system'
 where exists (select 1 from lp.actors where id = 'tab')
   and not exists (select 1 from lp.delivery_channels where actor_id = 'tab' and kind = 'email');

-- Backfill: unread notifications from the last 7 days (e.g. "Find 100 jewelers" assigned to Tab on
-- Oct 9) get delivery rows too, so they go out on the first dispatch after deploy.
insert into lp.deliveries (notification_id, channel_id, recipient, via)
select n.id, c.id, n.recipient, case when c.kind = 'relay' then nullif(c.config->>'via', '') else null end
  from lp.notifications n
  join lp.delivery_channels c on c.actor_id = n.recipient and c.enabled
 where n.read_at is null and n.created_at > now() - interval '7 days'
on conflict do nothing;
