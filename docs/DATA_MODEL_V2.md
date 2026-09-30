# Marketing Dashboard — Unified Data Model v2 (SPEC)

**Status:** spec for review — not implemented.
**Author:** Muse (main agent), 2026-09-30.
**For:** @leaddesk + @build-data / @build-ui.

## 1. Why this exists

Yaakov's words: *"I feel like I'm running around like a chicken without a
head. I have email campaigns over here, ideas, leads — different things
scattered all over the place. I want to see what's working and what's not and
I have no real way of doing it."*

The dashboard today answers exactly one question — "how is Instantly email
doing" — and right now it answers even that badly (failed collection run,
5-of-8 campaigns visible, zero active campaigns shown, empty sender fleet,
one day of history). This spec makes it answer the real question:
**what's working across ideas, leads, campaigns, channels, and angles —
and what does it cost.**

Scope note (Yaakov, 2026-09-30): there is no SMS or voice traffic today.
Email is the only live channel. The model below is email-first with channels
as a first-class entity so SMS/voice slot in later without a rewrite.

## 2. Source inventory

| # | Source | What we pull | Auth | State |
|---|--------|--------------|------|-------|
| 1 | Instantly (via Composio) | campaign analytics, overview, sender fleet, lead lists | Composio `instantly_moline-parsec` | **live, buggy** — the 4 known bugs are being fixed |
| 2 | ZeroBounce | credit balance, bulk verification job results | `custom.zerobounce` vault credential → box env | credential exists, not yet wired |
| 3 | MillionVerifier | verification results, credit balance | `custom.millionverifier` vault credential → box env | credential exists; **test reachability from the OVH box first** — api.millionverifier.com returned Cloudflare 1010 (IP ban) from Hatch egress on 2026-09-15; OVH egress is a different network |
| 4 | Porkbun | domain inventory, registration/expiry dates | **missing** — needs API key + secret key pair generated in the Porkbun panel (website login is in the vault, but the API needs the key pair; the single-secret connector can't hold both, so store as two named vault entries and sync to box env) | blocked on Yaakov |
| 5 | InboxKit | purchased inbox inventory, renewal/expiry dates, warmup state if exposed | **missing** — no credential on record; verify what API surface exists before designing the collector | blocked on Yaakov |
| 6 | Ideas | — | manual entry in dashboard UI | new |
| 7 | Costs | — | manual entry in dashboard UI to start (invoices live in email; automate later) | new |

Auth rule: keys live in the box environment (or the vault synced to it).
**Never in the repo, never in a commit, never in chat.** Follow the existing
`scripts/git-push.sh` pattern — builders never touch raw tokens.

## 3. The model

House rules still apply to every new table: `NULL` is "the API did not say",
`0` is a measurement; every rate recomputed from raw counts; upserts keyed on
natural keys; a failed collection is a row in the health surface, never a zero.

```sql
-- IDEAS: the unit of "what are we trying". Everything rolls up here.
create table ideas (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  hypothesis text,
  status text not null default 'backlog',  -- backlog|testing|live|paused|killed|won
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- CHANNELS: email today; sms/voice later. No schema change when they arrive.
create table channels (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,   -- 'email'
  type text not null
);

-- CAMPAIGNS: link every campaign to its idea and channel.
alter table campaigns add column idea_id uuid references ideas(id);
alter table campaigns add column channel_id uuid references channels(id);
alter table campaigns add column label text;  -- freeform, e.g. 'jewelry-restock'

-- ANGLES: message variants inside a campaign. This is "what angle works".
create table angles (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id) not null,
  name text not null,          -- 'A: keep-100%' / 'B: statement-review'
  step int,                    -- sequence step; null if campaign-level
  subject text,
  unique (campaign_id, name)
);
create table angle_daily_metrics (
  angle_id uuid references angles(id),
  metric_date date not null,
  sent int,
  replies_human int,
  replies_autoresponder int,
  positive_replies int,
  meetings int,
  primary key (angle_id, metric_date)
);

-- LEADS: one row per email, lifecycle across campaigns.
create table leads (
  id uuid primary key default gen_random_uuid(),
  email citext unique not null,
  first_name text,
  company text,
  source text,                 -- 'jewelry-osm' | 'builders-vibeking' | ...
  source_detail text,           -- list/import name
  zb_status text, zb_substatus text, zb_verified_at timestamptz,
  mv_result text, mv_subresult text, mv_verified_at timestamptz,
  first_contacted_at timestamptz,
  first_campaign_id uuid references campaigns(id),
  replied_at timestamptz,
  reply_sentiment text,         -- 'positive'|'neutral'|'negative' (see §6)
  meeting_booked_at timestamptz,
  customer_at timestamptz,
  updated_at timestamptz default now()
);

-- VERIFICATION_RUNS: list quality over time, per provider.
create table verification_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,       -- 'zerobounce' | 'millionverifier'
  list_name text not null,
  ran_at timestamptz default now(),
  total int, valid int, invalid int,
  catch_all int, do_not_mail int, unknown int,
  credits_used int
);

-- DOMAINS: Porkbun inventory + DNS health.
create table domains (
  domain text primary key,
  registrar text not null default 'porkbun',
  registered_at timestamptz,
  expires_at timestamptz,
  auto_renew bool,
  spf_ok bool, dkim_ok bool, dmarc_ok bool,
  dns_checked_at timestamptz,
  notes text
);

-- INBOXES: purchased mailboxes, reconciled against the Instantly fleet.
create table inboxes (
  email citext primary key,
  domain text references domains(domain),
  provider text not null default 'inboxkit',
  purchased_at timestamptz,
  expires_at timestamptz,
  warmup_status text,
  warmup_score numeric,
  daily_limit int,
  instantly_connected bool,     -- present in Instantly LIST_ACCOUNTS?
  instantly_status int,
  checked_at timestamptz default now()
);

-- COSTS: every dollar, categorized. Manual entry to start.
create table costs (
  id uuid primary key default gen_random_uuid(),
  cost_date date not null,
  category text not null,       -- 'domain'|'inbox'|'verification'|'tool'|'list'
  entity_ref text,              -- domain / email / list name
  amount_usd numeric not null,
  notes text
);
```

Extend `daily_metrics` with `cost_usd` and `leads_contacted` when the
collectors can populate them honestly (null until then).

## 4. Collectors

Each collector is a small script next to `collect_instantly.py`, same
contract: collect → upsert by natural key → record run health. Cadence:
Instantly daily (exists); verification on each bulk run; Porkbun +
InboxKit daily (expiry/warmup don't change hourly).

- **leads** (new): pull per-campaign lead lists from Instantly
  (`INSTANTLY_LIST_LEADS`, `campaign` param — known to work). Upsert into
  `leads` keyed on email. Do NOT overwrite verification columns on re-pull;
  only lifecycle columns move forward.
- **zerobounce** (new): credit balance + finished bulk-job summaries into
  `verification_runs`. Join `zb_status` onto `leads` by email.
- **millionverifier** (new): same shape. Reachability test from the OVH box
  is a prerequisite, not an afterthought.
- **porkbun** (new): `POST https://api.porkbun.com/api/json/v3/domain/listAll`
  with apikey/secretkey → `domains`. DNS checks (SPF/DKIM/DMARC via
  `dig`/DoH) run separately and fill the `*_ok` columns.
- **inboxkit** (new): **first verify the API surface** — list mailboxes,
  renewal dates, warmup state. Minimum viable: purchased inventory +
  expiries so the dashboard can warn before inboxes die (this already
  almost happened on 2026-09-18).
- **angles** (new): inspect what `INSTANTLY_GET_CAMPAIGN_ANALYTICS` returns
  per step/variant. If the API exposes step-level stats, collect them into
  `angle_daily_metrics`; if it doesn't, say so in the spec and design the
  manual alternative (one campaign per angle) instead of faking it.

## 5. What the dashboard must answer (acceptance)

After v2, these are one screen each — if a question needs a spreadsheet,
the model failed:

1. Which **idea** produced the most meetings per $100 spent this month?
2. Which **angle** has the best human reply rate inside each campaign?
3. What % of each **list** verified valid — which source gives the cleanest lists?
4. Which **inboxes/domains** are unhealthy or expiring in the next 14 days?
5. Funnel per campaign and per idea: contacted → replied → positive → meeting → customer.
6. Cost per reply / per meeting / per customer, by campaign and by idea.

## 6. Open questions for Yaakov

1. **Porkbun API key pair** — generate in the Porkbun panel and hand over via
   the vault (two entries: key + secret)? Or is website-login-only acceptable
   for now (no — API is the honest path; just needs his click)?
2. **InboxKit** — is there an API / API key? Where do renewal dates live today?
3. **Ideas** — where do they live right now (notes app, head)? Manual entry in
   the dashboard acceptable as the starting point?
4. **Costs** — manual entry acceptable to start?
5. **Reply sentiment** (positive/neutral/negative) — who classifies? Options:
   lightweight LLM pass over reply text in the collector, or manual tagging
   in the UI. Needs his call before anyone builds it.
6. **MillionVerifier vs ZeroBounce** — which is the primary verifier going
   forward? (Affects which status column the UI treats as canonical.)

## 7. Sequencing

- **Phase 0** (in flight): fix the 4 Instantly bugs. Nothing below matters
  until the base numbers are true.
- **Phase 1**: leads + verification (lead pull, `leads`, `verification_runs`).
- **Phase 2**: ideas + angles + costs (schema + manual-entry UI).
- **Phase 3**: domains + inboxes collectors (needs §6 Q1–Q2 answered).
- **Phase 4**: UI — the "what's working" views from §5.

@build-data owns §3–§4, @build-ui owns the §5 views and the manual-entry
forms, @build-copy owns every new label and empty state, @build-qa verifies
each phase against live data before the next starts.
