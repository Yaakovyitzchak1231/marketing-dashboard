-- Phase 2, P2-A (Oct 11, 2026): the segment condition engine (plan 2.1), the
-- backend of static lists (2.4) and the snapshot table segment analytics (2.12)
-- read from.
--
--   lp.segments          one row per segment: dynamic (definition jsonb,
--                         recomputed on read) or static (a hand-picked list,
--                         membership in lp.segment_members). campaign_id null
--                         means "all campaigns"; set, it scopes the segment to
--                         one campaign (e.g. a per-campaign starter segment).
--   lp.segment_members    static-list membership (and a place a dynamic
--                         segment's membership could be cached later, e.g. by
--                         the nightly snapshot job -- not required by this PR).
--   lp.segment_snapshots  one row per segment per run of the (future) runner
--                         job: size over time, for 2.12's sparkline/alerts.
--
-- lp.status_history already lists entity_type 'segment' (migration 0017), and
-- lp.event_types already has room for new keys (0018's registry) -- this file
-- seeds 'segment_joined' / 'segment_left' so segment_add_members /
-- segment_remove_members (lib/segments/ops.ts) can emit them.

create table if not exists lp.segments (
  id            bigint generated always as identity primary key,
  name          text not null check (length(name) between 1 and 120),
  description   text check (description is null or length(description) <= 2000),
  kind          text not null default 'dynamic' check (kind in ('dynamic', 'static')),
  campaign_id   bigint references lp.campaigns(id) on delete set null,  -- null = all campaigns
  entity        text not null check (entity in ('company', 'contact')),
  definition    jsonb not null default '{"entity":"company","include":[],"exclude":[]}'::jsonb
                  check (jsonb_typeof(definition) = 'object'),
  is_preset     boolean not null default false,
  preset_key    text check (preset_key is null or preset_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  archived_at   timestamptz,
  created_by    text references lp.actors(id),
  updated_by    text references lp.actors(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists segments_campaign_idx on lp.segments (campaign_id) where campaign_id is not null;
create index if not exists segments_kind_idx on lp.segments (kind);
create index if not exists segments_live_idx on lp.segments (archived_at) where archived_at is null;
create unique index if not exists segments_preset_key_uq on lp.segments (preset_key) where preset_key is not null and archived_at is null;
drop trigger if exists segments_updated on lp.segments;
create trigger segments_updated before update on lp.segments for each row execute function lp.touch_updated_at();

create table if not exists lp.segment_members (
  id           bigint generated always as identity primary key,
  segment_id   bigint not null references lp.segments(id) on delete cascade,
  company_id   bigint references lp.companies(id) on delete cascade,
  contact_id   bigint references lp.contacts(id) on delete cascade,
  added_by     text references lp.actors(id),
  source       text not null default 'hand' check (source in ('hand', 'import', 'api', 'rule')),
  added_at     timestamptz not null default now(),
  check ((company_id is not null) <> (contact_id is not null))   -- exactly one of company or contact
);
create unique index if not exists segment_members_company_uq on lp.segment_members (segment_id, company_id) where company_id is not null;
create unique index if not exists segment_members_contact_uq on lp.segment_members (segment_id, contact_id) where contact_id is not null;
create index if not exists segment_members_company_idx on lp.segment_members (company_id) where company_id is not null;
create index if not exists segment_members_contact_idx on lp.segment_members (contact_id) where contact_id is not null;

create table if not exists lp.segment_snapshots (
  id          bigint generated always as identity primary key,
  segment_id  bigint not null references lp.segments(id) on delete cascade,
  taken_at    timestamptz not null default now(),
  taken_on    date not null default current_date,  -- plain column, not a (taken_at::date) index expression:
                                                     -- that cast is STABLE (reads the session timezone), not
                                                     -- IMMUTABLE, and Postgres refuses it in an index.
  companies   integer not null default 0,
  contacts    integer not null default 0,
  sendable    integer not null default 0   -- verified-sendable contacts, at the time of the snapshot
);
create index if not exists segment_snapshots_segment_idx on lp.segment_snapshots (segment_id, taken_at desc);
-- At most one snapshot per segment per day, so a re-run of the runner job is a no-op, not a duplicate row.
create unique index if not exists segment_snapshots_daily_uq on lp.segment_snapshots (segment_id, taken_on);

insert into lp.event_types (key, label, category, source) values
  ('segment_joined', 'Joined segment', 'lifecycle', 'dashboard'),
  ('segment_left',   'Left segment',   'lifecycle', 'dashboard')
on conflict (key) do nothing;
