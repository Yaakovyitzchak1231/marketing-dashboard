-- 0008: pause / stop an agent from the dashboard.
--
-- A paused agent keeps its token, its tasks, its claims and its memory; every
-- request it makes to /api/ops/* is refused (423) until a human resumes it.
-- "Pause all agents" is one row in lp.agent_pause_all: while it exists, every
-- agent is refused, including agents added later.
--
-- Rules the database itself enforces:
--   * only an agent can be paused (a human actor can never carry a pause);
--   * only a human can pause or resume (paused_by must be a human actor).

alter table lp.actors
  add column if not exists paused_at    timestamptz,
  add column if not exists paused_by    text references lp.actors(id),
  add column if not exists pause_reason text;

alter table lp.actors drop constraint if exists actors_pause_agents_only;
alter table lp.actors add constraint actors_pause_agents_only
  check (paused_at is null or kind = 'agent');

alter table lp.actors drop constraint if exists actors_pause_complete;
alter table lp.actors add constraint actors_pause_complete
  check ((paused_at is null and paused_by is null) or (paused_at is not null and paused_by is not null));

create table if not exists lp.agent_pause_all (
  id         boolean primary key default true check (id),   -- at most one row
  paused_at  timestamptz not null default now(),
  paused_by  text not null references lp.actors(id),
  reason     text
);

create or replace function lp.pause_by_human_only() returns trigger language plpgsql as $$
begin
  if new.paused_by is not null
     and not exists (select 1 from lp.actors h where h.id = new.paused_by and h.kind = 'human') then
    raise exception 'only a human can pause agents (paused_by = %)', new.paused_by;
  end if;
  return new;
end $$;

drop trigger if exists actors_pause_by_human on lp.actors;
create trigger actors_pause_by_human before insert or update of paused_by on lp.actors
  for each row execute function lp.pause_by_human_only();

drop trigger if exists pause_all_by_human on lp.agent_pause_all;
create trigger pause_all_by_human before insert or update on lp.agent_pause_all
  for each row execute function lp.pause_by_human_only();
