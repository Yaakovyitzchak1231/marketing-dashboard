-- Initial schema for marketing dashboard
-- Created for T3: Supabase schema + read API layer

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Campaigns table
CREATE TABLE campaigns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id text UNIQUE NOT NULL,      -- Instantly campaign id
    name text NOT NULL,
    status text,
    created_at timestamptz
);

-- Daily metrics per campaign
CREATE TABLE daily_metrics (
    id bigserial PRIMARY KEY,
    campaign_id uuid REFERENCES campaigns(id),
    metric_date date NOT NULL,
    emails_sent int,
    replies_total int,
    replies_human int,        -- autoresponders excluded
    replies_autoresponder int,
    opportunities int,
    bounces int,
    open_rate numeric,        -- NULL when the API does not report it
    unsubscribe int,          -- NULL likewise
    source_updated_at timestamptz,
    collected_at timestamptz DEFAULT now(),
    UNIQUE (campaign_id, metric_date)
);

-- Account-wide rollup including sender health
CREATE TABLE accounts (
    id bigserial PRIMARY KEY,
    metric_date date UNIQUE NOT NULL,
    emails_sent int,
    replies_human int,
    replies_autoresponder int,
    bounces int,
    opportunities int,
    opportunity_value numeric,
    mailbox_count int,
    healthy_mailboxes int,
    collected_at timestamptz DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX idx_daily_metrics_campaign_date ON daily_metrics(campaign_id, metric_date DESC);
CREATE INDEX idx_daily_metrics_date ON daily_metrics(metric_date DESC);
CREATE INDEX idx_accounts_date ON accounts(metric_date DESC);
CREATE INDEX idx_campaigns_external_id ON campaigns(external_id);