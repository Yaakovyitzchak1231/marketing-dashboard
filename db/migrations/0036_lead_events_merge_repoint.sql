-- Phase 2 review fix (#81, Viktor + real-data e2e): a merge must move the timeline
-- (lp.lead_events) to the surviving company/contact. The append-only guard from 0018
-- only allowed an id to become NULL (the FK's on-delete-set-null). This keeps every
-- 0018 rule and adds ONE narrow exception: inside a merge transaction (lib/merge/merge.ts
-- sets the transaction-local flag lp.merge = 'on'), company_id / contact_id may be
-- re-pointed; nothing else about the row may change. And "Forget this person"
-- (lib/retention/store.ts, which sets lp.maintenance = 'on' for its transaction) may
-- scrub the address: email_norm and props may change, nothing else (Hermes review on #88:
-- every other column, present or added later, is pinned by comparing the whole row as jsonb
-- minus the columns a branch may touch; no id may be nulled under that branch, and the 0018
-- null-an-id rule now only admits the FK's own on-delete-set-null action).
-- Add-only: replaces the function body; the trigger from 0018 keeps calling it.
create or replace function lp.lead_events_append_only() returns trigger language plpgsql as $$
declare
  n jsonb;
  o jsonb;
begin
  -- Same maintenance escape hatch as lp.status_history (retention, forget-a-person).
  if tg_op = 'DELETE' then
    if current_setting('lp.maintenance', true) = 'on' then
      return old;
    end if;
    raise exception 'lp.lead_events is append-only';
  end if;
  n := to_jsonb(new);
  o := to_jsonb(old);
  -- 0018 rule: an FK's on-delete-set-null may clear company/contact/campaign; nothing else changes.
  -- Only the FK action itself (it runs one trigger level down, so pg_trigger_depth() > 1) may
  -- do that; a direct UPDATE can't null an id, with or without lp.maintenance.
  if pg_trigger_depth() > 1
     and (n - 'company_id' - 'contact_id' - 'campaign_id') = (o - 'company_id' - 'contact_id' - 'campaign_id')
     and (new.company_id is null or new.company_id = old.company_id)
     and (new.contact_id is null or new.contact_id = old.contact_id)
     and (new.campaign_id is null or new.campaign_id = old.campaign_id) then
    return new;
  end if;
  -- A merge re-points the row to the survivor; every other column stays as it was.
  if current_setting('lp.merge', true) = 'on'
     and (n - 'company_id' - 'contact_id') = (o - 'company_id' - 'contact_id') then
    return new;
  end if;
  -- Forget-a-person scrubs PII from the timeline: only email_norm / props may change.
  -- Every other column (ids, instantly_campaign_id, step, actor, recorded_at, ...) is pinned,
  -- so no id can be nulled or re-pointed here.
  if current_setting('lp.maintenance', true) = 'on'
     and (n - 'email_norm' - 'props') = (o - 'email_norm' - 'props') then
    return new;
  end if;
  raise exception 'lp.lead_events is append-only';
end $$;
