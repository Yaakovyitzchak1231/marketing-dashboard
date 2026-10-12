# Campaign profiles

Every campaign (`lp.campaigns`) gets a **profile**: its industry, who it sells to, the
keywords and topics to track, the competitors to watch, the news feeds and forums to
read, the lead-source directories and trade shows to pull from, the buying-signal
rules and tech fingerprints to detect, its newsletter list, its UTM conventions, and
its KPIs. Nothing about the profile is hard-coded to one industry — jewelry and AI
agencies below are two worked examples, not special cases in the code. Every later
feature (the news monitor, trend charts, competitor tracking, the directory
lead-source connector, buying signals, the lookalike finder, the Monday digest) reads
its configuration from the campaign's profile instead of being written per industry.

## How it works for any new campaign

1. **Create the campaign** (`lp.campaigns`, unchanged from before).
2. **Open its Profile tab** (`/campaigns/:id/profile`). Step 1: type the industry and
   who you sell to (business types, geographies, roles, size, exclusions). Pick an
   existing pool or create a new one right there — pools are rows in `lp.pools`, not
   a fixed list, so a brand-new industry is never blocked.
3. **Suggest with AI** (optional, Step 2): one click sends the industry (plus any ICP
   notes and example customer websites) to a free/OSS AI provider and gets back
   keywords, topics, named competitors, real feed URLs, forums, directories, trade
   shows, signal rules, fingerprints, search phrases, place categories and negative
   keywords — each with a one-line rationale. **Every suggestion is saved as
   `suggested`, never auto-approved**, and every suggestion with something to fetch
   over HTTP is checked before you see it: a feed actually parses and has recent
   items, a page actually loads and `robots.txt` allows it, a subreddit actually
   exists. A "couldn't verify" badge is still approvable — it just says what the
   check found, so a mistaken guess from the AI doesn't masquerade as checked.
4. **Approve, reject, or add by hand** (Step 3): approve-all per kind, approve one at
   a time, or type your own competitor/feed/keyword directly. Only `approved` items
   are ever used by a monitor, connector or signal job — `approvedItems(campaignId,
   kind)` is the one function they call.
5. **Set UTM conventions and KPIs** (Step 4), then mark the profile active.
6. From here on, every feature that needs this campaign's configuration reads it from
   the profile: the news monitor pulls this campaign's `feed`/`forum` items, the trend
   charts track its `keyword`/`topic` items, competitor tracking uses its
   `competitor` items, the lead-source connector reads its `directory`/`trade_show`
   items (one generic connector, one config row per directory), buying signals run
   its `signal_rule` items, the lookalike finder and the find-leads engine read its
   `search_phrase`/`place_category` items, and the Monday digest has a section per
   active campaign.

## Data model

- `lp.campaign_profiles` — one row per campaign: `industry`, `vertical`,
  `description`, `icp` (jsonb: `business_types[]`, `size{employees_min,
  employees_max, revenue_min, revenue_max}`, `geographies[]`, `roles[]`,
  `exclude[]`), `value_prop`, `newsletter_list`, `utm` (jsonb:
  `source/medium/campaign/content_rule`), `kpis` (jsonb array of
  `{metric,target,period}`), `setup_status` (`draft → suggested → reviewed →
  active`), `ai_last_suggested_at`, `ai_model`.
- `lp.campaign_profile_items` — the lists: one row per keyword, competitor, feed,
  forum, directory, trade show, signal rule, fingerprint, social channel, negative
  keyword, search phrase or place category. Each has `status` (`suggested →
  approved`/`rejected`/`archived`), `source` (`human`/`ai`/`agent`/`import`/`copied`),
  an optional `rationale`, and `verify_status`/`verify_detail`/`verified_at` for
  anything checkable over HTTP.
- `lp.pools` — industries/audiences as rows (e.g. `jeweler`, `ai_agency`,
  `ai_builder`, plus whatever Yaakov adds), referenced by `lp.campaigns.pool`.
- Every write records one `lp.status_history` row (`entity_type` `campaign_profile`,
  `field` like `industry` or `item:competitor:Toast`), naming who changed it and
  through which door (`ui` or `ops_api`).

## API (for agents, same functions the dashboard uses)

`get_campaign_profile`, `update_campaign_profile`, `add_profile_items`,
`set_profile_item_status`, `update_profile_item`, `suggest_campaign_profile`,
`copy_campaign_profile`, `list_profile_items`, `list_pools`, `create_pool`,
`recheck_profile_item`, `validate_campaign_profile`, `export_campaign_profile`,
`import_campaign_profile` — see `docs/AGENTS_API.md` for the full argument shapes.
`list_profile_items {kind}` with no `campaign_id` is what a monitor or connector
agent calls to fetch every approved item of a kind across every active campaign.
Features that need one campaign's approved profile call `profileFor` in
`lib/campaigns/profile.ts`; `activeProfiles` is that read for every non-archived
campaign whose profile is `active`. The signed-in door is
`GET /api/campaigns/:id/profile` (the route file is
`app/api/campaigns/[id]/profile/route.ts`).

## AI provider

Free/OSS only: any OpenAI-compatible chat completions endpoint — a local Ollama on
Yaakov's OVH server, Groq's free tier, OpenRouter's free models, etc. Configured for
now via `AI_BASE_URL` / `AI_API_KEY` (optional) / `AI_MODEL` env vars, behind one
`getAiConfig()` function (`lib/campaign-profiles/suggest.ts`) with a `TODO` to switch
to the settings store once that PR lands. With nothing configured, `suggest_campaign_profile`
answers `{configured:false}` and the wizard says "AI suggestions need an AI provider —
add one in Settings" — manual entry still works either way.

## Example campaign configs

These three show the same wizard producing a sensible setup for very different
industries. They are examples only — nothing below is a default or a special case in
the code.

### 1. Jewelers (B2B payments for independent jewelers)

- **Industry / ICP**: "Independent jewelers"; business types `independent jeweler`,
  `estate jeweler`; geographies `MD, VA, DC`; roles `owner, store manager`; size
  1–20 employees.
- **Competitors**: Square, Clover, PaymentCloud (each with `pricing_url`).
- **Feeds**: National Jeweler (`nationaljeweler.com/rss`... or its working feed URL),
  JCK Online, Rapaport news, InStore magazine.
- **Directories**: Jewelers of America "find a jeweler", American Gem Society "find a
  jeweler", Independent Jewelers Organization member list — each its own `directory`
  row with a connector config.
- **Trade shows**: JCK Las Vegas (`trade_show`, `config.exhibitor_list_url` to the
  public exhibitor directory).
- **Signal rules**: `tech_change` (POS/processor swap detected on the lead's site),
  `hiring` (new store manager posted), `new_location` (second storefront opens).
- **Fingerprints**: known POS/payment-processor JS snippets.

### 2. AI agencies / AI builders (TapDash's second audience)

- **Industry / ICP**: "AI agencies and AI-tool builders"; business types `AI agency`,
  `indie AI builder`; roles `founder, head of ops`.
- **Competitors**: a short list of payment/billing tools AI agencies already use.
- **Feeds**: Hacker News front page (`hnrss.org`), the Hugging Face blog, Latent
  Space, a Ben's-Bites-style newsletter feed.
- **Forums**: `r/LocalLLaMA`, `r/artificial`, relevant Discord-adjacent subreddits.
- **Directories**: Product Hunt's public "AI tools" listings, a GitHub topic search
  for new agent frameworks (both read-only, public).
- **Signal rules**: `funding` (seed/Series A announced), `hiring` (first sales hire —
  a buying signal for a tool that needs billing).

### 3. Dental clinics (an unrelated industry, to show it generalizes)

- **Industry / ICP**: "Dental clinics"; business types `general dentistry`,
  `orthodontics`; geographies `MD, VA`; roles `office manager, owner dentist`; size
  2–15 employees.
- **Competitors**: Dentrix, Open Dental (practice-management software, with
  `pricing_url`).
- **Feeds**: Dental Economics, a state dental association's news feed.
- **Directories**: a state dental association's member directory, ADA "find a
  dentist" (public listing pages).
- **Signal rules**: `hiring` (new office manager posted), `page_change` (a new
  "now accepting new patients" page goes up — a growth signal).
- **Fingerprints**: common dental scheduling widgets (e.g. a booking-widget script
  tag), useful both as a buying signal and to confirm the lead is a real practice.

These three live only here and in the test fixtures (`tests/campaign-profiles-*`) —
never as defaults in the application code.
