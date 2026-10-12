-- 0052: never leave the team without an active human owner (Instinct #86 finding 6).
--
-- lib/team/store.ts already refuses to demote or remove the last owner, but only
-- on its own path, and with a read-then-write that two owners clicking at once
-- could both pass. Nothing stopped any other write from leaving lp.actors with
-- zero active human owners; every database-backed owner check
-- (requireHumanOwner in lib/tags/ops.ts, the 0050/0051 team trigger, the instantly
-- gate) would then fail for everyone except the ALLOWED_USER_EMAIL fallback.
--
-- "Active human owner" = kind = 'human' and role = 'owner' and active (the same
-- test 0050 uses). This AFTER trigger fires when a row that WAS an active human
-- owner stops being one (role changed, deactivated, kind or id changed, or the
-- row deleted) and refuses the change if no active human owner is left. It runs
-- after the whole statement's rows are written, so a multi-row update that
-- demotes every owner at once is caught too. To swap owners, promote the new one
-- first, then demote the old one.
--
-- The legacy 'owner' row (seeded in 0001, role 'owner' since 0029) is the actor
-- the ALLOWED_USER_EMAIL login writes as (lib/auth/session.ts currentActorId). It
-- counts as an active human owner like any other, and it can't itself be
-- demoted, deactivated, renamed or deleted: if it lost its owner role, Yaakov's
-- permanent login would still be an owner in the app (lib/auth/roles.ts) but
-- every database owner check made as 'owner' would refuse him. The Team screen
-- never lists that row (listTeamMembers shows rows with an email), so this only
-- stops a hand-made query or a crafted form post.
--
-- Escape hatch for genuine maintenance (same as 0051): a transaction that sets
-- lp.migration = 'on' is not checked.
--
-- Add-only: a new function and trigger; nothing existing changes.

create or replace function lp.actors_keep_an_owner() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('lp.migration', true), '') = 'on' then
    return null;
  end if;
  if not (old.kind = 'human' and old.role = 'owner' and old.active) then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if new.kind = 'human' and new.role = 'owner' and new.active and new.id = old.id then
      return null;
    end if;
  end if;

  if old.id = 'owner' then
    raise exception 'The built-in owner login can''t be demoted, deactivated or removed. It is the account ALLOWED_USER_EMAIL signs in as.'
      using errcode = '23514';
  end if;

  if not exists (
    select 1 from lp.actors a where a.kind = 'human' and a.role = 'owner' and a.active
  ) then
    raise exception 'Cannot remove or demote the last owner. Make someone else owner first.'
      using errcode = '23514';
  end if;
  return null;
end $$;

drop trigger if exists actors_keep_an_owner on lp.actors;
create trigger actors_keep_an_owner after update of role, active, kind, id or delete on lp.actors
  for each row execute function lp.actors_keep_an_owner();
