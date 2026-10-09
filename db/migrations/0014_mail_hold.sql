-- 0014: email deliveries wait for mail settings instead of failing for good.
--
-- Before this, a delivery on an email channel with MAIL_PROVIDER / MAIL_API_KEY / MAIL_FROM unset
-- was marked failed at once ("mail is not configured ...") and never retried. Now the app holds
-- it (status 'held', no attempt spent) and sends it within minutes of the settings existing.
-- This puts any email delivery that already failed that way back on hold, and lets the
-- per-notification status show why something is held ("waiting for mail setup" vs Shabbos).
-- Safe to run more than once.

update lp.deliveries d
   set status = 'held',
       attempts = 0,
       failed_at = null,
       last_error = 'waiting for mail settings (MAIL_PROVIDER, MAIL_API_KEY, MAIL_FROM)',
       next_attempt_at = now(),
       updated_at = now()
  from lp.delivery_channels c
 where c.id = d.channel_id
   and c.kind = 'email'
   and d.status = 'failed'
   and d.last_error like 'mail is not configured%';

-- Same view as 0013, except last_error is also shown for held rows (the reason they wait).
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
       max(d.last_error) filter (where d.status in ('failed', 'held')) as last_error,
       min(d.next_attempt_at) filter (where d.status = 'held') as held_until
  from lp.notifications n
  left join lp.deliveries d on d.notification_id = n.id
 group by n.id, n.read_at;
