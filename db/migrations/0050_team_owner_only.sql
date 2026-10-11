-- 0050: only an owner can add people, change roles or remove people.
--
-- Yaakov's rule (Oct 11, 2026): the Owner controls roles. The app already
-- checks this in app/actions/team.ts and lib/team/store.ts; this makes the
-- database refuse it too, so no other path (an ops-API op running as an agent,
-- an editor's server action, a future route that forgets the check) can add a
-- human login, change a role, change a login email, deactivate a person or
-- delete one.
--
-- Who is acting comes from lp.actor, which every app write sets for its
-- transaction (db.tx(fn, actor) -> set_config('lp.actor', ..., true)). When it
-- names someone, that someone must be an active human owner. When it is unset
-- (migrations, seeds, an admin at a psql prompt) the change is allowed, as
-- before. The ALLOWED_USER_EMAIL owner writes as actor 'owner', whose row has
-- role 'owner' (0029).
--
-- Agents' own rows (kind = 'agent': pause, last seen, quiet hours) are not
-- touched by this. Add-only; nothing existing is changed.

create or replace function lp.team_change_by_owner_only() returns trigger language plpgsql as $$
declare
  who text := nullif(current_setting('lp.actor', true), '');
begin
  if tg_op = 'INSERT' then
    if new.kind is distinct from 'human' then
      return new;
    end if;
  elsif tg_op = 'UPDATE' then
    if old.kind is distinct from 'human' and new.kind is distinct from 'human' then
      return new;
    end if;
    if new.role is not distinct from old.role
       and new.active is not distinct from old.active
       and new.email is not distinct from old.email
       and new.kind is not distinct from old.kind
       and new.id is not distinct from old.id then
      return new;
    end if;
  elsif tg_op = 'DELETE' then
    if old.kind is distinct from 'human' then
      return old;
    end if;
  end if;

  if who is not null and not exists (
    select 1 from lp.actors a
     where a.id = who and a.kind = 'human' and a.active and a.role = 'owner'
  ) then
    raise exception 'Only an owner can add people, change roles or remove people (acting as %).', who
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

drop trigger if exists actors_team_owner_only on lp.actors;
create trigger actors_team_owner_only before insert or update or delete on lp.actors
  for each row execute function lp.team_change_by_owner_only();
