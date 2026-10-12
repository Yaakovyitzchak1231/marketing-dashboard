-- 0054: lp.find_jobs — the durable per-run record for find-leads jobs.
--
-- find_leads tasks live in lp.tasks (scheduling/claiming); this table is the
-- domain record: the pool as a real FK into lp.pools (rows, not hard-coded),
-- the campaign, the resolved params snapshot, which config source the run
-- used ("profile" vs "built-in default for pool X"), lifecycle status and
-- counters. The Find leads history no longer depends on task-table internals.
--
-- Add-only: no existing object is touched.

create table if not exists lp.find_jobs (
  id            bigint generated always as identity primary key,
  task_id       bigint not null unique references lp.tasks(id) on delete cascade,
  campaign_id   bigint references lp.campaigns(id) on delete set null,
  pool          text not null references lp.pools(id) on update cascade,
  title         text not null,
  status        text not null default 'pending'
                  check (status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  params        jsonb not null default '{}'::jsonb,
  config_source text,
  counters      jsonb not null default '{}'::jsonb,
  error         text,
  report        text,
  created_by    text references lp.actors(id),
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
create index if not exists find_jobs_pool_idx on lp.find_jobs (pool);
create index if not exists find_jobs_campaign_idx on lp.find_jobs (campaign_id);
create index if not exists find_jobs_status_idx on lp.find_jobs (status);

-- Best-effort backfill: one row per existing find_leads task whose stored
-- segment is a real pool row (0020 backfilled lp.pools from stored values, so
-- this is nearly all of them). Tasks whose segment has no pool row are left
-- out rather than violating the FK.
insert into lp.find_jobs (task_id, campaign_id, pool, title, status, params, config_source, created_by, created_at, finished_at)
select t.id,
       (t.payload->>'campaign_id')::bigint,
       t.payload->>'segment',
       t.title,
       case t.status
         when 'done' then 'done'
         when 'failed' then 'failed'
         when 'cancelled' then 'cancelled'
         when 'claimed' then 'running'
         when 'running' then 'running'
         else 'pending'
       end,
       t.payload,
       t.payload->>'config_source',
       t.created_by,
       t.created_at,
       case when t.status in ('done', 'failed', 'cancelled') then t.finished_at end
  from lp.tasks t
  join lp.pools p on p.id = t.payload->>'segment'
 where t.kind = 'find_leads'
   and t.payload->>'segment' ~ '^[a-z][a-z0-9_]{0,40}$'
   and not exists (select 1 from lp.find_jobs j where j.task_id = t.id);
