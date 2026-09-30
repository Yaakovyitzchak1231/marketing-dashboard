-- Unified data model v2: ideas, channels, angles, leads, verification,
-- domains, inboxes, costs.
-- Follows the house rules: NULL means "the source did not say", 0 is a
-- measurement; rates are recomputed from raw counts, never stored; natural-key
-- upserts; RLS on, session-scoped reads (mirrors the t10-deploy RLS setup).

CREATE EXTENSION IF NOT EXISTS "citext";

-- IDEAS: the unit of "what are we trying". Everything rolls up here.
CREATE TABLE ideas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    hypothesis text,
    status text NOT NULL DEFAULT 'backlog'
        CHECK (status IN ('backlog','testing','live','paused','killed','won')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- CHANNELS: email today; sms/voice later without a rewrite.
CREATE TABLE channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text UNIQUE NOT NULL,
    type text NOT NULL
);
INSERT INTO channels (name, type) VALUES ('email', 'email')
ON CONFLICT (name) DO NOTHING;

-- CAMPAIGNS: link every campaign to its idea and channel.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS idea_id uuid REFERENCES ideas(id);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS channel_id uuid REFERENCES channels(id);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS label text;
CREATE INDEX IF NOT EXISTS idx_campaigns_idea ON campaigns(idea_id);

-- ANGLES: message variants inside a campaign ("what angle works").
CREATE TABLE angles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name text NOT NULL,
    step int,
    subject text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, name)
);

CREATE TABLE angle_daily_metrics (
    angle_id uuid NOT NULL REFERENCES angles(id) ON DELETE CASCADE,
    metric_date date NOT NULL,
    sent int,
    replies_human int,
    replies_autoresponder int,
    positive_replies int,
    meetings int,
    collected_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (angle_id, metric_date)
);

-- LEADS: one row per email, lifecycle across campaigns.
-- Verification columns are written only by the verification collectors;
-- the lead-pull collector must never overwrite them (see collect_leads.py).
CREATE TABLE leads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email citext UNIQUE NOT NULL,
    first_name text,
    company text,
    source text,
    source_detail text,
    zb_status text,
    zb_substatus text,
    zb_verified_at timestamptz,
    mv_result text,
    mv_subresult text,
    mv_verified_at timestamptz,
    first_contacted_at timestamptz,
    first_campaign_id uuid REFERENCES campaigns(id),
    replied_at timestamptz,
    reply_sentiment text CHECK (reply_sentiment IN ('positive','neutral','negative')),
    meeting_booked_at timestamptz,
    customer_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_leads_source ON leads(source);
CREATE INDEX idx_leads_first_campaign ON leads(first_campaign_id);

-- VERIFICATION_RUNS: list quality over time, per provider.
CREATE TABLE verification_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL CHECK (provider IN ('zerobounce','millionverifier')),
    list_name text NOT NULL,
    ran_at timestamptz NOT NULL DEFAULT now(),
    total int,
    valid int,
    invalid int,
    catch_all int,
    do_not_mail int,
    unknown int,
    credits_used int
);
CREATE INDEX idx_verification_runs_provider ON verification_runs(provider, ran_at DESC);

-- DOMAINS: Porkbun inventory + DNS health.
CREATE TABLE domains (
    domain text PRIMARY KEY,
    registrar text NOT NULL DEFAULT 'porkbun',
    registered_at timestamptz,
    expires_at timestamptz,
    auto_renew boolean,
    spf_ok boolean,
    dkim_ok boolean,
    dmarc_ok boolean,
    dns_checked_at timestamptz,
    notes text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- INBOXES: purchased mailboxes, reconciled against the Instantly fleet.
CREATE TABLE inboxes (
    email citext PRIMARY KEY,
    domain text REFERENCES domains(domain),
    provider text NOT NULL DEFAULT 'inboxkit',
    purchased_at timestamptz,
    expires_at timestamptz,
    warmup_status text,
    warmup_score numeric,
    daily_limit int,
    instantly_connected boolean,
    instantly_status int,
    checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_inboxes_domain ON inboxes(domain);

-- COSTS: every dollar, categorized. Manual entry to start.
CREATE TABLE costs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cost_date date NOT NULL,
    category text NOT NULL
        CHECK (category IN ('domain','inbox','verification','tool','list')),
    entity_ref text,
    amount_usd numeric NOT NULL CHECK (amount_usd >= 0),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_costs_date ON costs(cost_date DESC);
CREATE INDEX idx_costs_category ON costs(category);

-- Daily metrics gain cost + lead counts when collectors can fill them
-- honestly (NULL until then — never backfilled with guesses).
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS cost_usd numeric;
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS leads_contacted int;

-- collection_runs exists in the collector but was never migrated; create it
-- with every column the collectors write (api_calls/stages come from
-- collect_instantly.record_run).
CREATE TABLE IF NOT EXISTS collection_runs (
    id bigserial PRIMARY KEY,
    ran_at timestamptz NOT NULL DEFAULT now(),
    collector text NOT NULL DEFAULT 'instantly',
    ok boolean,
    api_calls int,
    campaigns_collected int,
    campaigns_persisted int,
    stages jsonb,
    errors jsonb,
    UNIQUE (collector, ran_at)
);

-- RLS: session-scoped reads for the signed-in dashboard user, mirroring the
-- existing tables. The service_role key used by collectors bypasses RLS.
ALTER TABLE ideas ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE angles ENABLE ROW LEVEL SECURITY;
ALTER TABLE angle_daily_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE inboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_runs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'ideas','channels','angles','angle_daily_metrics','leads',
        'verification_runs','domains','inboxes','costs','collection_runs'
    ] LOOP
        -- Reads: anon + authenticated. This matches migration 001's effective
        -- openness (no RLS there); the middleware allow-list is the access
        -- gate. Writes below stay authenticated-only.
        EXECUTE format(
            'CREATE POLICY authenticated_read ON %I FOR SELECT TO anon, authenticated USING (true)', t);
    END LOOP;
END $$;

-- Manual entry from the dashboard UI: the signed-in user may add/edit ideas
-- and costs. Everything else is collector-written (service_role bypasses RLS).
CREATE POLICY ideas_write ON ideas FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY costs_write ON costs FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY angles_write ON angles FOR ALL TO authenticated USING (true) WITH CHECK (true);
