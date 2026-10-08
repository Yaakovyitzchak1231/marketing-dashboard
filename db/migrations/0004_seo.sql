-- SEO / AEO / GEO section (additive to 0001-0003).
--
--   lp.seo_sites               the websites we track (WordPress on SiteGround, Lovable, ...)
--   lp.seo_audits              one row per technical audit run, with every check's outcome
--   lp.seo_prompts             the questions people ask AI assistants ("best card processor for jewelers")
--   lp.seo_competitors         names/domains to look for in AI answers
--   lp.seo_visibility_runs     one row per AI-visibility run against one model
--   lp.seo_visibility_results  one row per (run, prompt): the answer and who it named
--
-- lp.seo_changes            every change made to WordPress from the dashboard (diff + undo)
--
-- Fix-list items are ordinary lp.tasks rows (kind = 'seo_fix') in the
-- "SEO / AI visibility" project, so any human or agent can claim them through
-- the same board and ops API. Plain, portable PostgreSQL.

create table lp.seo_sites (
  id          bigint generated always as identity primary key,
  name        text not null,
  base_url    text not null unique,            -- origin, e.g. https://tapdash.co
  platform    text,                            -- wordpress | lovable | other (free text)
  host        text,                            -- siteground | lovable | ...
  campaign    text,                            -- jewelers | builders | general ...
  pages       text[] not null default '{}',    -- key paths to audit besides '/'
  brand_terms text[] not null default '{}',    -- words that mean "we were mentioned" in an AI answer
  active      boolean not null default true,
  notes       text,
  created_by  text references lp.actors(id),
  created_at  timestamptz not null default now()
);

create table lp.seo_audits (
  id           bigint generated always as identity primary key,
  site_id      bigint not null references lp.seo_sites(id) on delete cascade,
  status       text not null default 'running' check (status in ('running', 'done', 'failed')),
  checks       jsonb not null default '[]'::jsonb,  -- [{id, label, status: pass|warn|fail|unknown, detail, fix, page}]
  pages        jsonb not null default '{}'::jsonb,  -- path -> {url, title, description, canonical, h1, schemaTypes, monthlyPrice}
  sitemap_urls jsonb,                                -- null = no sitemap read
  passed       integer,                              -- null until done
  failed       integer,
  warned       integer,
  unknown      integer,
  fetched_from text,                                 -- where the fetches ran (e.g. 'dashboard server')
  error        text,
  created_by   text references lp.actors(id),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index seo_audits_site_idx on lp.seo_audits (site_id, id desc);

create table lp.seo_prompts (
  id          bigint generated always as identity primary key,
  prompt      text not null,
  campaign    text,
  active      boolean not null default true,
  created_by  text references lp.actors(id),
  created_at  timestamptz not null default now()
);
create unique index seo_prompts_uq on lp.seo_prompts (lower(prompt));

create table lp.seo_competitors (
  id      bigint generated always as identity primary key,
  name    text not null,
  domain  text,
  created_at timestamptz not null default now()
);
create unique index seo_competitors_uq on lp.seo_competitors (lower(name));

create table lp.seo_visibility_runs (
  id           bigint generated always as identity primary key,
  provider     text not null,                 -- openai | anthropic | gemini | perplexity
  model        text not null,
  status       text not null default 'running' check (status in ('running', 'done', 'failed')),
  prompt_count integer,
  mentioned    integer,                       -- answers that named us; null until done
  error        text,
  created_by   text references lp.actors(id),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create table lp.seo_visibility_results (
  id             bigint generated always as identity primary key,
  run_id         bigint not null references lp.seo_visibility_runs(id) on delete cascade,
  prompt_id      bigint references lp.seo_prompts(id) on delete set null,
  prompt         text not null,               -- the words actually asked (prompts can be edited later)
  answer         text,
  error          text,
  mentioned      boolean,                     -- null = no answer
  matched_terms  text[] not null default '{}',
  competitors    text[] not null default '{}',
  cited_urls     text[] not null default '{}',
  created_at     timestamptz not null default now()
);
create index seo_vis_results_run_idx on lp.seo_visibility_results (run_id);

-- Changes the dashboard makes to a WordPress site, one row per change, with the
-- value before and after so every change can be shown as a diff and undone.
create table lp.seo_changes (
  id           bigint generated always as identity primary key,
  site_id      bigint not null references lp.seo_sites(id) on delete cascade,
  task_id      bigint references lp.tasks(id) on delete set null,
  kind         text not null,                -- unpublish_page | set_meta | add_schema | create_draft
  target       text not null,                -- e.g. 'page 123 /test-inner-page-2/'
  wp_id        bigint,                       -- the WordPress post/page id touched or created
  status       text not null default 'applied' check (status in ('applied', 'undone', 'failed')),
  before       jsonb,                        -- the fields as they were (what undo writes back)
  after        jsonb,                        -- the fields as written
  error        text,
  applied_by   text references lp.actors(id),
  applied_at   timestamptz not null default now(),
  undone_by    text references lp.actors(id),
  undone_at    timestamptz
);
create index seo_changes_site_idx on lp.seo_changes (site_id, id desc);
create index seo_changes_task_idx on lp.seo_changes (task_id);

insert into lp.projects (name, description, lead_actor, created_by) values
  ('SEO / AI visibility', 'Fixes that help tapdash.co and the campaign sites show up in Google and in ChatGPT, Claude, Gemini and Perplexity answers', 'tab', 'system')
on conflict (name) do nothing;

-- The sites found on Oct 8, 2026 (Google site: search, the tapdash.co sitemap, and the builders link Yaakov shared Oct 6).
insert into lp.seo_sites (name, base_url, platform, host, campaign, pages, brand_terms, created_by) values
  ('TapDash (main + jewelers)', 'https://tapdash.co', 'wordpress', 'siteground', 'jewelers',
   array['/jewelers/', '/jewelers/compare/', '/digital/', '/partners/'], array['TapDash', 'tapdash.co'], 'system'),
  ('TapDash for builders', 'https://ai-builder-pay.lovable.app', 'lovable', 'lovable', 'builders',
   array[]::text[], array['TapDash', 'ai-builder-pay'], 'system')
on conflict (base_url) do nothing;

insert into lp.seo_prompts (prompt, campaign, created_by) values
  ('What is the best credit card processor for jewelry stores?', 'jewelers', 'system'),
  ('Best payment processing for an independent jewelry store with high-ticket sales', 'jewelers', 'system'),
  ('Which card processor won''t hold funds on large jewelry sales?', 'jewelers', 'system'),
  ('Square vs Clover for a jewelry store, and are there better options?', 'jewelers', 'system'),
  ('Payment processor with dual pricing for retail stores', 'general', 'system'),
  ('Best Stripe alternative for AI agencies building apps for clients', 'builders', 'system'),
  ('Payment processor with revenue share for agencies and app builders', 'builders', 'system')
on conflict do nothing;

insert into lp.seo_competitors (name, domain) values
  ('Square', 'squareup.com'), ('Clover', 'clover.com'), ('Stripe', 'stripe.com'), ('Helcim', 'helcim.com'),
  ('Stax', 'staxpayments.com'), ('Payment Depot', 'paymentdepot.com'), ('Flute', 'flute.com'),
  ('AllayPay', 'allaypay.com'), ('Shopify', 'shopify.com'), ('PayPal', 'paypal.com'), ('Toast', 'toasttab.com'),
  ('Lightspeed', 'lightspeedhq.com'), ('Authorize.net', 'authorize.net'), ('Paysafe', 'paysafe.com')
on conflict do nothing;
