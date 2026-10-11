-- AI-visibility accounting (additive to 0004_seo.sql).
--
-- An empty or blocked model response is not a "not named" result: we simply
-- could not read an answer, so it must stay unknown. These columns record what
-- actually happened on a run and the configuration it used, so a mention rate
-- can be computed from the answers we truly read instead of from the prompts we
-- merely asked.
--
--   attempted  prompts sent to the provider
--   answered   answers we could read (mentioned true or false)
--   failed     provider calls that returned an error
--   unknown    responses that came back empty/blocked (no answer to read)
--
-- web_search, brand_terms and prompts snapshot the run, so a later change to
-- the questions or the brand terms cannot rewrite what a past run meant.
--
-- Counts stay nullable on purpose: runs with no stored results keep null and
-- the dashboard falls back to reading their result rows.

alter table lp.seo_visibility_runs
  add column if not exists attempted  integer,
  add column if not exists answered   integer,
  add column if not exists failed     integer,
  add column if not exists unknown    integer,
  add column if not exists web_search boolean,
  add column if not exists brand_terms text[],
  add column if not exists prompts    jsonb;

-- Historical configuration is not recoverable: leave it NULL, never invent
-- web-search=false or an empty prompt/brand configuration for those runs.
-- Empty text WAS stored by the old runner, so its invalid negative verdict
-- can be corrected from evidence. Provider errors have no measured verdict.
update lp.seo_visibility_results
   set mentioned = null, matched_terms = '{}', competitors = '{}'
 where error is not null or answer is null or answer !~ '[^[:space:]]';

-- Backfill historical runs from their stored results. A result is an answer
-- only when `mentioned` is set; an error is a failure; anything else is unknown.
update lp.seo_visibility_runs r
set attempted = c.attempted,
    answered  = c.answered,
    failed    = c.failed,
    unknown   = c.unknown,
    mentioned = case when c.answered > 0 then c.mentioned else null end
from (
  select run_id,
         count(*)::int                                                    as attempted,
         count(*) filter (where mentioned is not null and error is null)::int as answered,
         count(*) filter (where error is not null)::int                   as failed,
         count(*) filter (where mentioned is null and error is null)::int as unknown,
         count(*) filter (where mentioned = true and error is null)::int as mentioned
    from lp.seo_visibility_results
   group by run_id
) c
where r.id = c.run_id;
