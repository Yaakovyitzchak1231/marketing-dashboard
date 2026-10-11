-- Legacy agents predate addActor()'s default pull channel. Preserve any explicit
-- fetch-channel choice (including disabled channels); never silently re-enable it.
insert into lp.delivery_channels (actor_id, kind, label, config, created_by)
select a.id, 'pull', 'Checks its feed (default)', '{}'::jsonb, 'system'
  from lp.actors a
 where a.kind = 'agent' and a.active and a.id not in ('system', 'instantly-ai')
   and not exists (
     select 1 from lp.delivery_channels c
      where c.actor_id = a.id and c.kind in ('pull', 'stream', 'mcp', 'ntfy')
   );

-- Recover unread notifications that had no usable feed, without re-offering
-- notifications already acknowledged on another channel. Safe to run again.
insert into lp.deliveries (notification_id, channel_id, recipient)
select n.id, c.id, n.recipient
  from lp.notifications n
  join lp.actors a on a.id = n.recipient and a.kind = 'agent' and a.active
  join lp.delivery_channels c on c.actor_id = n.recipient and c.enabled
 where n.read_at is null and c.kind in ('pull', 'stream', 'mcp', 'ntfy')
   and not exists (
     select 1 from lp.deliveries d
      where d.notification_id = n.id and d.delivered_at is not null
   )
on conflict (notification_id, channel_id) do nothing;
