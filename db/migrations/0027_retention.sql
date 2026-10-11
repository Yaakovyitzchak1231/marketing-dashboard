-- Phase 2, P2-C (plan 1.12): data retention & delete-a-person (privacy).
--
--   lp.retention_policies  how long raw per-event records are kept, by event
--                          category (today: lp.campaign_touches.event_type).
--                          keep_days null = forever. Seeded with sensible
--                          defaults; editable in Settings -> Data.
--   lp.suppressions        gets email_hash: a sha256 hex of the normalized
--                          email, computed by the app (no pgcrypto here --
--                          this schema adds no extensions). A forgotten
--                          person is suppressed by hash alone, so the
--                          plaintext address they asked to be forgotten is
--                          not the thing keeping them out of a re-import.
--
-- forget_contact (lib/retention/store.ts) removes PII from a contact in place
-- (it is the anonymized tombstone -- the row and its company membership stay),
-- scrubs the PII copies that live elsewhere (lp.campaign_touches.email, the
-- email on lp.verification_results, lp.enrichment, lp.sources), and clears
-- that contact's own edit history under the maintenance escape hatch (0017),
-- since that history is exactly the kind of place an old email address hides.
-- retention_sweep deletes lp.campaign_touches rows past their category's
-- keep_days; it is registered below as a job definition so it shows up next
-- to the other background jobs (lib/jobs) -- the OVH runner's handler for
-- kind 'retention_sweep' is Needs Yaakov (see the PR write-up); until then
-- "Run sweep now" in Settings calls the same op directly.

create table if not exists lp.retention_policies (
  event_category  text primary key check (event_category ~ '^[a-z][a-z0-9_]{0,60}$'),
  keep_days       integer check (keep_days is null or keep_days > 0),
  description     text check (description is null or length(description) <= 300),
  updated_by      text references lp.actors(id),
  updated_at      timestamptz not null default now()
);
drop trigger if exists retention_policies_updated on lp.retention_policies;
create trigger retention_policies_updated before update on lp.retention_policies for each row execute function lp.touch_updated_at();

insert into lp.retention_policies (event_category, keep_days, description) values
  ('email_opened',        540, 'Raw "opened" pixel events from Instantly'),
  ('link_clicked',        540, 'Raw link-click events from Instantly'),
  ('email_link_clicked',  540, 'Raw link-click events from Instantly (alt event name)'),
  ('email_sent',          null, 'Send log -- kept forever for attribution'),
  ('email_bounced',       null, 'Bounce log -- kept forever'),
  ('reply_received',      null, 'Replies -- kept forever'),
  ('lead_unsubscribed',   null, 'Unsubscribes -- kept forever'),
  ('meeting_booked',      null, 'Meetings -- kept forever')
on conflict (event_category) do nothing;

alter table lp.suppressions add column if not exists email_hash text check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$');
alter table lp.suppressions drop constraint if exists suppressions_check;
alter table lp.suppressions add constraint suppressions_identity_check check (
  (case when email_norm is not null then 1 else 0 end) +
  (case when domain     is not null then 1 else 0 end) +
  (case when email_hash is not null then 1 else 0 end) = 1
);
create unique index if not exists suppressions_hash_live_uq
  on lp.suppressions (email_hash, coalesce(campaign_id, 0)) where email_hash is not null and lifted_at is null;

-- Register the sweep as a job definition (lib/jobs), disabled by default (no
-- schedule) until Yaakov turns it on in Settings or the OVH runner gets a
-- handler for kind 'retention_sweep'; "owner" can also run it on demand now.
insert into lp.jobs (name, kind, description, schedule_cron, timezone, enabled, created_by)
values ('retention_sweep', 'retention_sweep', 'Deletes raw campaign-touch events past their retention policy''s keep_days.', null, 'America/New_York', false, 'system')
on conflict (name) do nothing;
