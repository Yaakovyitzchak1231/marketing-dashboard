-- Phase 1 foundation, part 2 (Oct 10, 2026): the universal audit log.
--
-- lp.status_history becomes the audit log for every inline edit, not just company
-- stage and contact status: any entity type the dashboard or an agent edits gets a
-- row per changed field, naming who changed it (lp.actor for the transaction) and
-- through which door (via). It becomes append-only, like lp.events.
--
-- One deliberate escape hatch: a maintenance transaction that runs
--   select set_config('lp.maintenance', 'on', true)
-- may delete rows (data retention, "forget this person", test fixtures). Nothing
-- in the app sets it during normal edits, and updates are never allowed.

alter table lp.status_history drop constraint if exists status_history_entity_type_check;
alter table lp.status_history add constraint status_history_entity_type_check
  check (entity_type in ('company', 'contact', 'task', 'campaign', 'campaign_lead', 'campaign_profile',
                         'actor', 'setting', 'suppression', 'job', 'pool', 'integration', 'event_type',
                         'deal', 'segment', 'journey'));

-- Some entities are keyed by a text slug, not a number (a setting 'workspace.timezone',
-- an actor 'tab', a job name, a pool 'dental_clinics', an integration 'listmonk').
-- Those rows carry entity_key and leave entity_id null; numeric entities keep entity_id.
alter table lp.status_history alter column entity_id drop not null;
alter table lp.status_history add column if not exists entity_key text
  check (entity_key is null or length(entity_key) between 1 and 200);
alter table lp.status_history drop constraint if exists status_history_identity_check;
alter table lp.status_history add constraint status_history_identity_check
  check (entity_id is not null or entity_key is not null);
create index if not exists status_history_key_idx on lp.status_history (entity_type, entity_key, changed_at desc)
  where entity_key is not null;

-- Which door the change came through: the dashboard UI, the ops API (an agent's own
-- key), the Instantly webhook, the background runner, an import, or a DB trigger.
alter table lp.status_history add column if not exists via text
  check (via is null or via in ('ui', 'ops_api', 'webhook', 'runner', 'import', 'trigger'));
alter table lp.status_history add column if not exists note text
  check (note is null or length(note) <= 1000);

create index if not exists status_history_changed_idx on lp.status_history (changed_at desc);
create index if not exists status_history_actor_idx on lp.status_history (changed_by, changed_at desc);

create or replace function lp.status_history_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('lp.maintenance', true) = 'on' then
    return old;
  end if;
  raise exception 'lp.status_history is append-only';
end $$;
drop trigger if exists status_history_no_update on lp.status_history;
create trigger status_history_no_update before update or delete on lp.status_history
  for each row execute function lp.status_history_append_only();
