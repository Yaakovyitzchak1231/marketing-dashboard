-- Lead engine checkpoints (additive to 0001).
--
-- A "Find leads" job is an lp.tasks row (kind = 'find_leads'). Whoever claims
-- it (Tab by default, or any agent/human runner) works through it in stages
-- and writes every step here, so a crash, a reboot or a hand-off resumes where
-- it stopped instead of starting over:
--
--   lp.engine_runs   one row per find_leads task: params, current stage,
--                    counters (a snapshot computed from engine_items), notes.
--   lp.engine_items  one row per map search and per business found, with the
--                    stage it reached, attempts, last error and the data so far.
--
-- Plain, portable PostgreSQL; nothing Supabase-specific.

create table lp.engine_runs (
  id            bigint generated always as identity primary key,
  task_id       bigint not null unique references lp.tasks(id) on delete cascade,
  params        jsonb not null,
  status        text not null default 'running' check (status in ('running', 'done', 'failed', 'cancelled')),
  stage         text,                      -- discover | crawl | owner | build | done
  counters      jsonb not null default '{}'::jsonb,
  notes         jsonb not null default '[]'::jsonb,   -- plain-English notes, e.g. "owner search skipped: no search provider set"
  runner        text references lp.actors(id),
  started_at    timestamptz not null default now(),
  heartbeat_at  timestamptz,
  finished_at   timestamptz,
  error         text
);

create table lp.engine_items (
  id          bigint generated always as identity primary key,
  run_id      bigint not null references lp.engine_runs(id) on delete cascade,
  kind        text not null check (kind in ('search', 'place')),
  item_key    text not null,               -- search: 'city|ST|query|offset'; place: maps place id / cid / domain
  stage       text not null,               -- search: queued|searched. place: kept|crawled|owner|built
  status      text not null default 'pending' check (status in ('pending', 'done', 'failed', 'dropped')),
  attempts    integer not null default 0,
  data        jsonb not null default '{}'::jsonb,
  error       text,                        -- last error, or the drop reason (chain, no_website, already_in_leads ...)
  company_id  bigint references lp.companies(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (run_id, kind, item_key)
);
create index engine_items_work_idx on lp.engine_items (run_id, kind, status, stage, id);
create index engine_items_company_idx on lp.engine_items (company_id) where company_id is not null;
create trigger engine_items_updated before update on lp.engine_items for each row execute function lp.touch_updated_at();
