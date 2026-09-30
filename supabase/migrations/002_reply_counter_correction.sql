-- T3 follow-up: correct the reply columns before any row is written.
--
-- Migration 001 modelled replies as (replies_total, replies_human,
-- replies_autoresponder) where replies_human = replies_total - autoresponder.
-- That is wrong against the real Instantly payload, and it is wrong in a way
-- that produces a negative count rather than a visibly wrong one.
--
-- Evidence from the live account (instantly_moline-parsec), 8 campaigns,
-- INSTANTLY_GET_CAMPAIGN_ANALYTICS:
--
--   campaign                     replies_unique  replies_automatic_unique
--   TapDash Jewelry Retailers         8                    10
--   IRS Penalty Back                  9                     0
--   PB Signups / Leads             1357                     8
--
-- On TapDash the automatic count EXCEEDS the unique count. So
-- reply_count_unique and reply_count_automatic_unique are independent counters
-- over different populations, not a partition of one. Subtracting them yields
-- -2, and a negative "human reply count" would sail through every rate check
-- in this repo because -2 / 2126 is a valid-looking percentage.
--
-- There is therefore no human-reply column. Both counters are stored raw, and
-- the schema never asserts that one is a subset of the other.
--
-- Second correction: rates. reply_count_unique > emails_sent_count is
-- arithmetically impossible (9 unique replies from 2 sends), and no other
-- field in the payload resolves it -- contacted_count and
-- new_leads_contacted_count are equal to or smaller than emails_sent_count,
-- and leads_count (the largest at 4) is still smaller than 9. Verified with
-- and without an explicit start_date/end_date window; the numbers do not
-- change. Where numerator > denominator the rate is NULL, and the reason is
-- stored so the UI never has to invent a threshold.

-- ---------------------------------------------------------------- campaigns
DROP TABLE IF EXISTS daily_metrics CASCADE;

CREATE TABLE daily_metrics (
    id bigserial PRIMARY KEY,
    campaign_id uuid REFERENCES campaigns(id),
    metric_date date NOT NULL,

    -- Raw counts exactly as Instantly reports them. Never derived, never
    -- differenced. NULL means the collector did not collect this field.
    emails_sent              int,
    contacted_count          int,
    new_leads_contacted      int,
    leads_count              int,

    -- Two independent counters. replies_unique is NOT a superset of
    -- replies_automatic_unique and must never be differenced against it.
    replies_unique           int,
    replies_automatic_unique int,
    replies_all              int,

    bounces                  int,
    opportunities            int,
    opportunity_value        numeric,

    -- Nullable with NO DEFAULT. Instantly returns open_count_unique = 0 and
    -- unsubscribed_count = 0 for every campaign and for the overview, which is
    -- a metric it never measured. The collector writes NULL for these; a
    -- DEFAULT 0 here would quietly undo that on every insert that omits them.
    opens_unique             int,
    unsubscribed             int,

    -- Whether Instantly actually reported these metrics, as opposed to
    -- returning a placeholder 0. The routes read this: without it a stored 0
    -- would render as a genuine "0.0% open rate", which is bug 3. It must
    -- exist here too, not only on accounts -- a per-campaign open rate is
    -- exactly where the 0.0% bug is most visible.
    open_reported            boolean NOT NULL DEFAULT FALSE,
    unsub_reported           boolean NOT NULL DEFAULT FALSE,

    -- Denominator actually used to compute the rate, so the choice is a
    -- stored fact rather than a constant baked into a UI.
    denominator_source       text,
    -- FALSE whenever the rate is NULL or otherwise not trustworthy. @build-copy
    -- keys the "not enough sends to calculate" copy off this flag, so the
    -- number and the words cannot disagree.
    rate_trusted             boolean,
    -- Why the rate is untrusted: 'numerator_exceeds_denominator',
    -- 'insufficient_sends', or the collector error stage name.
    rate_untrusted_reason    text,
    -- Bounce rate is gated by the same rules but is a separate measurement
    -- with its own trust decision: a campaign can have a valid reply rate and
    -- an unusable bounce rate. Both gates are stored so neither has to be
    -- recomputed and re-judged at read time.
    bounce_rate_trusted      boolean,
    bounce_rate_untrusted_reason text,
    -- TRUE when this campaign's numbers came from a partial collection.
    partial                  boolean,
    collected_at             timestamptz DEFAULT now(),

    UNIQUE (campaign_id, metric_date),

    -- A trusted rate is one the collector actually computed and validated.
    -- Anything else must be explicitly untrusted. This is a CHECK rather than
    -- a convention so a bad insert fails at the database, not on screen.
    CONSTRAINT rate_trust_requires_reason
        CHECK (rate_trusted = TRUE OR rate_untrusted_reason IS NOT NULL)
);

-- ---------------------------------------------------------------- accounts
-- Same correction at the rollup. The overview endpoint returns the same
-- 45,545 / 1,910 / 39 counters.
DROP TABLE IF EXISTS accounts CASCADE;

CREATE TABLE accounts (
    id bigserial PRIMARY KEY,
    metric_date date UNIQUE NOT NULL,

    emails_sent              int,
    contacted_count          int,
    new_leads_contacted      int,

    replies_unique           int,
    replies_automatic_unique int,
    replies_all              int,

    bounces                  int,
    unsubscribed             int,
    opportunities            int,
    opportunity_value        numeric,

    -- Mailbox counts come from INSTANTLY_LIST_ACCOUNTS. When that call fails
    -- the collector writes NULL here. It must NOT write 0: a zero would claim
    -- the fleet is empty when in fact we did not get to ask.
    mailbox_count            int,
    healthy_mailboxes        int,
    warmup_score_avg         numeric,

    -- No DEFAULT on opens: see daily_metrics. Instantly does not populate it.
    opens_unique             int,
    open_reported            boolean NOT NULL DEFAULT FALSE,
    unsub_reported           boolean NOT NULL DEFAULT FALSE,

    denominator_source       text,
    rate_trusted             boolean,
    rate_untrusted_reason    text,
    bounce_rate_trusted      boolean,
    bounce_rate_untrusted_reason text,
    partial                  boolean,

    -- Campaigns discovered in the inventory, which is not the same as the
    -- campaigns that successfully collected. QA's arithmetic: 5 surviving
    -- rows summed to 33,686 sent against an overview total of 45,545 -- 26%
    -- of portfolio volume silently missing. The headline count must come from
    -- the collected ID list, so both numbers are stored and can be compared.
    campaigns_inventory_count int,
    campaigns_collected_count int,

    collected_at timestamptz DEFAULT now(),

    CONSTRAINT accounts_rate_trust_requires_reason
        CHECK (rate_trusted = TRUE OR rate_untrusted_reason IS NOT NULL)
);

-- ------------------------------------------------- collection error record
-- /build-copy's partial-data banner reads this. The count in the banner is the
-- collector's own count, never a guess: errors here are the failed calls.
CREATE TABLE collection_errors (
    id bigserial PRIMARY KEY,
    collected_at timestamptz NOT NULL DEFAULT now(),
    run_started_at timestamptz,
    stage text NOT NULL,              -- 'overview', 'campaign:<id8>', 'senders'
    campaign_external_id text,        -- NULL for account-level stages
    error text NOT NULL,
    resolved boolean NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_collection_errors_unresolved
    ON collection_errors (collected_at DESC) WHERE resolved = FALSE;
CREATE INDEX idx_collection_errors_campaign
    ON collection_errors (campaign_external_id);

-- ------------------------------------------------------------------- senders
CREATE TABLE IF NOT EXISTS senders (
    id bigserial PRIMARY KEY,
    email text UNIQUE NOT NULL,
    domain text,
    status int,                    -- 1 and 2 are Instantly's healthy values
    setup_pending boolean,
    daily_limit int,
    warmup_score int,
    warmup_status text,
    created_at timestamptz,
    collected_at timestamptz DEFAULT now()
);

CREATE INDEX idx_senders_domain ON senders (domain);

-- ----------------------------------------------------------------- indexes
CREATE INDEX idx_daily_metrics_campaign_date
    ON daily_metrics (campaign_id, metric_date DESC);
CREATE INDEX idx_daily_metrics_date
    ON daily_metrics (metric_date DESC);
CREATE INDEX idx_accounts_date
    ON accounts (metric_date DESC);
CREATE INDEX idx_campaigns_external_id
    ON campaigns (external_id);

-- --------------------------------------------------------------------- RLS
-- The dashboard reads with the anon key, so reads are public. There is no
-- write path from the browser: the collector holds the service_role key and
-- runs on the OVH VM. If a browser ever needs to write, this is the line that
-- has to move first.
ALTER TABLE daily_metrics     ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE senders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns         ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read daily_metrics"     ON daily_metrics     FOR SELECT USING (true);
CREATE POLICY "read accounts"          ON accounts          FOR SELECT USING (true);
CREATE POLICY "read collection_errors" ON collection_errors FOR SELECT USING (true);
CREATE POLICY "read senders"           ON senders           FOR SELECT USING (true);
CREATE POLICY "read campaigns"         ON campaigns         FOR SELECT USING (true);
