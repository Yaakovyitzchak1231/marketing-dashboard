-- Phase 2, plan 1.14: more than one human login, with roles.
--
-- lp.actors already has a 'human' kind (today just the single 'owner' row,
-- Yaakov). This adds role + email so additional humans (Izzy, etc.) can sign
-- in with Owner / Editor / Viewer permissions, enforced server-side in
-- app/actions/* and lib/auth/roles.ts.
--
-- ALLOWED_USER_EMAIL remains a PERMANENT fallback owner, entirely outside this
-- table: lib/auth/roles.ts always resolves that env email to 'owner' first,
-- before ever consulting lp.actors, so a bad migration, an emptied actors
-- table, or a mistaken demote/remove here can never lock Yaakov out. No
-- Vercel env change is needed for this slice.

alter table lp.actors add column if not exists role text
  check (role is null or role in ('owner', 'editor', 'viewer'));

alter table lp.actors add column if not exists email text
  check (email is null or email = lower(email));

-- Role and email are human concepts; agents (Tab, Hermes, Instantly AI, ...)
-- keep authenticating with their own ops-API keys, untouched by this.
alter table lp.actors drop constraint if exists actors_role_humans_only;
alter table lp.actors add constraint actors_role_humans_only
  check (role is null or kind = 'human');
alter table lp.actors drop constraint if exists actors_email_humans_only;
alter table lp.actors add constraint actors_email_humans_only
  check (email is null or kind = 'human');

create unique index if not exists actors_email_unique_idx
  on lp.actors (email) where email is not null;

-- Give the existing owner actor a role so nothing changes behaviourally for
-- Yaakov today; the env fallback never depended on this row anyway.
update lp.actors set role = 'owner' where id = 'owner' and role is null;
