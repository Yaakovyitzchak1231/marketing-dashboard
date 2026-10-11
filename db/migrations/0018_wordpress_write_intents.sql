-- Journal intent BEFORE any external mutation. Uncertain operations keep their
-- resource reserved until verified; never automatically replay a WordPress write.
alter table lp.seo_changes drop constraint if exists seo_changes_status_check;
alter table lp.seo_changes add constraint seo_changes_status_check
  check (status in ('applying', 'applied', 'unknown', 'undoing', 'undo_unknown', 'undone', 'failed'));
alter table lp.seo_changes add column if not exists resource_key text;
alter table lp.seo_changes add column if not exists input_key text;
alter table lp.seo_changes add column if not exists created_at timestamptz not null default now();
alter table lp.seo_changes alter column applied_at drop not null;
alter table lp.seo_changes alter column applied_at drop default;
create unique index if not exists seo_changes_inflight_resource_uq
  on lp.seo_changes (site_id, resource_key)
  where status in ('applying', 'unknown', 'undoing', 'undo_unknown');
create index if not exists seo_changes_input_idx on lp.seo_changes (site_id, input_key);
