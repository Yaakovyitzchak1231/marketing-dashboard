-- Phase 2 review fix (#81, Viktor + real-data e2e): a merge must move the timeline
-- (lp.lead_events) to the surviving company/contact. The append-only guard from 0018
-- only allowed an id to become NULL (the FK's on-delete-set-null). This keeps every
-- 0018 rule and adds ONE narrow exception: inside a merge transaction (lib/merge/merge.ts
-- sets the transaction-local flag lp.merge = 'on'), company_id / contact_id may be
-- re-pointed; nothing else about the row may change. And "Forget this person"
-- (lib/retention/store.ts, which sets lp.maintenance = 'on' for its transaction) may
-- scrub the address: email_norm and props may change, nothing else.
-- Add-only: replaces the function body; the trigger from 0018 keeps calling it.
create or replace function lp.lead_events_append_only() returns trigger language plpgsql as $$
begin
  -- Same maintenance escape hatch as lp.status_history (retention, forget-a-person).
  if tg_op = 'DELETE' and current_setting('lp.maintenance', true) = 'on' then
    return old;
  end if;
  if tg_op = 'UPDATE'
     and new.id = old.id and new.type = old.type and new.occurred_at = old.occurred_at
     and new.props = old.props and new.source = old.source
     and new.dedupe_key is not distinct from old.dedupe_key
     and (new.company_id is null or new.company_id = old.company_id)
     and (new.contact_id is null or new.contact_id = old.contact_id)
     and (new.campaign_id is null or new.campaign_id = old.campaign_id) then
    return new;
  end if;
  -- A merge re-points the row to the survivor; every other column stays as it was.
  if tg_op = 'UPDATE' and current_setting('lp.merge', true) = 'on'
     and new.id = old.id and new.type = old.type and new.occurred_at = old.occurred_at
     and new.props = old.props and new.source = old.source
     and new.dedupe_key is not distinct from old.dedupe_key
     and new.campaign_id is not distinct from old.campaign_id
     and new.email_norm is not distinct from old.email_norm then
    return new;
  end if;
  -- Forget-a-person scrubs PII from the timeline: only email_norm / props may change.
  if tg_op = 'UPDATE' and current_setting('lp.maintenance', true) = 'on'
     and new.id = old.id and new.type = old.type and new.occurred_at = old.occurred_at
     and new.source = old.source
     and new.dedupe_key is not distinct from old.dedupe_key
     and (new.company_id is null or new.company_id = old.company_id)
     and (new.contact_id is null or new.contact_id = old.contact_id)
     and (new.campaign_id is null or new.campaign_id = old.campaign_id) then
    return new;
  end if;
  raise exception 'lp.lead_events is append-only';
end $$;
