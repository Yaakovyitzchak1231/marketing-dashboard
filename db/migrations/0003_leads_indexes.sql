-- Read paths for the Leads / Replies / Overview screens. Additive only.
-- campaign_touches had no company index; the leads list and the reply desk
-- look up "latest touch for this company" per row.
create index if not exists campaign_touches_company_idx on lp.campaign_touches (company_id, occurred_at desc);
create index if not exists campaign_touches_event_idx   on lp.campaign_touches (event_type, occurred_at desc);
create index if not exists tasks_company_idx            on lp.tasks (company_id) where company_id is not null;
create index if not exists sources_ref_idx              on lp.sources (kind, source_ref);
