-- Phase 1 foundation, part 2 (Oct 10, 2026): the universal audit log.
--
-- lp.status_history becomes the audit log for every inline edit, not just company
-- stage and contact status: any entity type the dashboard or an agent edits gets a
-- row per changed field, naming who changed it (lp.actor for the transaction) and
-- through which door (via). It becomes append-only, like lp.events.

alter table lp.status_history drop constraint if exists status_history_entity_type_check;
alter table lp.status_history add constraint status_history_entity_type_check
  check (entity_type in ('company', 'contact', 'task', 'campaign', 'campaign_lead', 'campaign_profile',
                         'actor', 'setting', 'suppression', 'job', 'deal', 'segment', 'journey'));

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
  raise exception 'lp.status_history is append-only';
end $$;
drop trigger if exists status_history_no_update on lp.status_history;
create trigger status_history_no_update before update or delete on lp.status_history
  for each row execute function lp.status_history_append_only();
