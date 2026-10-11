-- Keep old mixed source lists untouched. Without the original provider metadata,
-- they cannot be reconstructed as verified citations or text-only mentions.
alter table lp.seo_visibility_runs
  add column if not exists measurement_version integer,
  add column if not exists site_snapshot jsonb;
alter table lp.seo_visibility_results
  add column if not exists text_mentioned boolean,
  add column if not exists citation_urls text[],
  add column if not exists retrieved_urls text[];
create index if not exists seo_visibility_site_snapshot_idx
  on lp.seo_visibility_runs using gin (site_snapshot);
