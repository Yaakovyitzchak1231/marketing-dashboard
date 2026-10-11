-- Phase 1 foundation, part 4 (Oct 10, 2026): suppression list + consent.
--
--   lp.suppressions  emails and whole domains that must never be pushed to a
--                    sender (Instantly today, Warmbly later). Checked before
--                    every push. campaign_id null = suppressed everywhere; a
--                    campaign id = only for that campaign. expires_at null = forever.
--                    Removing one is a soft delete (lifted_at), so the history stays.
--   lp.contacts.subscription_status  newsletter/opt-in state of a contact.
--   lp.consent_log   every change of that state, with where it came from.

create table if not exists lp.suppressions (
  id           bigint generated always as identity primary key,
  email_norm   text check (email_norm is null or email_norm = lower(trim(email_norm))),
  domain       text check (domain is null or domain = lower(trim(domain))),
  campaign_id  bigint references lp.campaigns(id) on delete cascade,   -- null = all campaigns
  reason       text not null check (reason in ('unsubscribed', 'bounced', 'complained', 'do_not_contact',
                                                'competitor', 'customer', 'manual', 'legal', 'other')),
  source       text not null default 'manual',   -- manual, instantly_webhook, import, ops_api, warmbly ...
  note         text check (note is null or length(note) <= 1000),
  created_by   text references lp.actors(id),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  lifted_at    timestamptz,
  lifted_by    text references lp.actors(id),
  check ((email_norm is not null) <> (domain is not null))     -- exactly one of email or domain
);
create unique index if not exists suppressions_email_live_uq
  on lp.suppressions (email_norm, coalesce(campaign_id, 0)) where email_norm is not null and lifted_at is null;
create unique index if not exists suppressions_domain_live_uq
  on lp.suppressions (domain, coalesce(campaign_id, 0)) where domain is not null and lifted_at is null;
create index if not exists suppressions_campaign_idx on lp.suppressions (campaign_id) where campaign_id is not null;

alter table lp.contacts add column if not exists subscription_status text not null default 'never_asked'
  check (subscription_status in ('subscribed', 'unsubscribed', 'bounced', 'never_asked'));

create table if not exists lp.consent_log (
  id          bigint generated always as identity primary key,
  contact_id  bigint not null references lp.contacts(id) on delete cascade,
  status      text not null check (status in ('subscribed', 'unsubscribed', 'bounced', 'never_asked')),
  source      text not null,                -- form, import, instantly_webhook, manual, ops_api ...
  evidence    text check (evidence is null or length(evidence) <= 2000),  -- e.g. form URL, reply excerpt
  actor       text references lp.actors(id),
  at          timestamptz not null default now()
);
create index if not exists consent_log_contact_idx on lp.consent_log (contact_id, at desc);

-- One place to ask "may we send to this address for this campaign?": true when a
-- live (not lifted, not expired) suppression covers the email or its domain,
-- globally or for that campaign.
create or replace function lp.is_suppressed(p_email text, p_campaign_id bigint default null)
returns boolean language sql stable as $$
  select exists (
    select 1 from lp.suppressions s
     where s.lifted_at is null
       and (s.expires_at is null or s.expires_at > now())
       and (s.campaign_id is null or s.campaign_id = p_campaign_id)
       and (s.email_norm = lower(trim(p_email))
            or s.domain = lower(split_part(trim(p_email), '@', 2)))
  )
$$;

-- Seed from what the database already knows: contacts flagged do-not-contact,
-- unsubscribed or bounced, so the very first push after this migration already
-- respects them.
insert into lp.suppressions (email_norm, reason, source, note)
select distinct c.email_norm,
       case when c.status = 'bounced' then 'bounced'
            when c.do_not_contact then 'do_not_contact'
            else 'do_not_contact' end,
       'backfill', 'seeded by migration 0019 from lp.contacts'
  from lp.contacts c
 where c.email_norm is not null
   and (c.do_not_contact or c.status in ('do-not-contact', 'bounced'))
on conflict do nothing;

insert into lp.suppressions (email_norm, reason, source, note)
select distinct lower(trim(t.email)),
       case when t.event_type = 'email_bounced' then 'bounced' else 'unsubscribed' end,
       'backfill', 'seeded by migration 0019 from lp.campaign_touches'
  from lp.campaign_touches t
 where t.email is not null and trim(t.email) <> ''
   and t.event_type in ('lead_unsubscribed', 'email_bounced')
on conflict do nothing;
