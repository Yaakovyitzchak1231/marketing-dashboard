-- 0009: agents never write to Instantly directly.
--
-- An agent (ops token) that wants a change in Instantly (add leads to a
-- campaign, pause or resume a campaign) now only queues it: an
-- lp.instantly_actions row in status 'awaiting_approval' plus a pending
-- lp.approvals row that shows in "Needs your OK" with a preview. Only a
-- human's Approve (with a confirm click) runs it; Reject records why.
--
-- Default-deny at the database too: a row can only move to 'sending' (the
-- moment just before the dashboard calls Instantly) when confirmed_by is an
-- active human actor. A code path that forgets the gate fails here.

alter table lp.instantly_actions add column if not exists approval_id bigint references lp.approvals(id) on delete set null;
alter table lp.instantly_actions add column if not exists requested_reason text;
alter table lp.instantly_actions add column if not exists decided_by text references lp.actors(id);
alter table lp.instantly_actions add column if not exists decision_note text;

alter table lp.instantly_actions drop constraint if exists instantly_actions_status_check;
alter table lp.instantly_actions add constraint instantly_actions_status_check
  check (status in ('preview', 'awaiting_approval', 'approved', 'rejected', 'sending', 'done', 'failed', 'unknown', 'cancelled'));

create index if not exists instantly_actions_approval_idx on lp.instantly_actions (approval_id);

-- The approval that holds an Instantly change points back at it, so the queue
-- can show the preview and the Approve button can run exactly that row.
alter table lp.approvals add column if not exists instantly_action_id bigint references lp.instantly_actions(id) on delete set null;

create or replace function lp.instantly_send_needs_human() returns trigger
language plpgsql as $$
begin
  if new.status = 'sending' and (tg_op = 'INSERT' or old.status is distinct from 'sending') then
    if new.confirmed_by is null or not exists (
      select 1 from lp.actors a where a.id = new.confirmed_by and a.kind = 'human' and a.active
    ) then
      raise exception 'Only a signed-in human can send a change to Instantly (confirmed_by=%).', coalesce(new.confirmed_by, 'nobody')
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists instantly_actions_human_only on lp.instantly_actions;
create trigger instantly_actions_human_only before insert or update on lp.instantly_actions
  for each row execute function lp.instantly_send_needs_human();
