-- 0051: team changes fail closed when nobody says who is acting (Instinct #86 finding 5).
--
-- 0050 made the database refuse team changes (add a person, change a role or a
-- login email, deactivate or delete a person) unless lp.actor names an active
-- human owner. But when lp.actor was UNSET it let the change through, on the
-- theory that only migrations, seeds and an admin at a psql prompt write without
-- it. A plain db.query outside db.tx(fn, actor), a one-off script or a future
-- route that forgets the actor would have been treated the same way.
--
-- Now the unset case is refused, unless the transaction carries the explicit,
-- transaction-local flag lp.migration = 'on'.
--
-- Why a flag and not current_user: the app (lib/db/pg.ts) and the migration
-- runner (scripts/db-migrate.mjs, run by `npm run vercel-build`) connect with the
-- SAME DATABASE_URL, so they are the same database role; on Supabase/Neon that
-- role is the database owner and on a self-hosted server it may be a superuser.
-- current_user, session_user and rolsuper therefore cannot tell the app from a
-- migration. The runner (scripts/lib/migrate.mjs) now sets
--   select set_config('lp.migration', 'on', true)
-- inside each migration's own transaction; it ends with that transaction, so it
-- can never leak into a pooled connection the app reuses. No app code sets it.
--
-- Who can still change the team:
--   * the app, through db.tx(fn, actor) with an active human owner (unchanged);
--   * migrations, through the runner (flag set per file);
--   * an admin at a psql prompt, by saying who they are:
--       begin; select set_config('lp.actor', 'owner', true); ...; commit;
--     or, for genuine maintenance with no person to name:
--       begin; select set_config('lp.migration', 'on', true); ...; commit;
--
-- Unchanged from 0050: agents' own rows (kind = 'agent': pause, last seen, quiet
-- hours, presence) and housekeeping columns on human rows (last_seen_at,
-- quiet_shabbos, status_note, paused_*) are not team changes and are not checked.
--
-- Also here (finding 5, "confirm no agent token maps to 'owner'"): no API key in
-- lp.agent_keys may belong to 'owner', the legacy human actor the
-- ALLOWED_USER_EMAIL login writes as. lib/notify/keys.ts already refuses to mint
-- a key for a person and agentForDbKey only accepts kind = 'agent'; this makes
-- the database refuse a key for 'owner' too (lib/ops/gate.ts refuses an
-- OPS_AGENT_TOKENS entry for 'owner' the same way). NOT VALID so this migration
-- never fails on whatever rows already exist (none is expected, and none could
-- authenticate: agentForDbKey requires kind = 'agent'); every new or changed row
-- is checked.
--
-- Add-only: replaces the 0050 function body (the 0050 trigger keeps calling it) and
-- adds one constraint.

create or replace function lp.team_change_by_owner_only() returns trigger language plpgsql as $$
declare
  who text := nullif(current_setting('lp.actor', true), '');
  migrating boolean := coalesce(current_setting('lp.migration', true), '') = 'on';
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

  if who is null then
    if not migrating then
      raise exception 'Team changes need to say who is making them: run them through db.tx(fn, actor) as an owner (no acting person was set, so nothing was changed).'
        using errcode = '42501',
              hint = 'An admin at a psql prompt can run select set_config(''lp.actor'', ''owner'', true) inside the transaction first.';
    end if;
  elsif not exists (
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

-- No API key for the legacy owner actor.
alter table lp.agent_keys drop constraint if exists agent_keys_not_legacy_owner;
alter table lp.agent_keys add constraint agent_keys_not_legacy_owner
  check (actor_id <> 'owner') not valid;
