/**
 * Warmbly (Yaakov's self-hosted cold-email + warm-up platform, v0.6.47 on his
 * OVH box) — the shapes the dashboard reads, TAP-118.
 *
 * Field names are Warmbly's own: list endpoints answer
 * `{ data: [...], pagination: { total, next_cursor, has_more } }`, and a row's
 * keys are the columns of its `email_accounts` / `campaigns` table (read from
 * the live database's information_schema on Oct 13, 2026). Every field is
 * optional here because the dashboard must never invent one: a key Warmbly did
 * not send renders as "not reported", never as 0 or false.
 */

export interface WarmblyPage<T> {
  data: T[]
  pagination?: { total?: number | null; next_cursor?: string | null; has_more?: boolean }
}

/** GET /v1/me with an API key. */
export interface WarmblyMe {
  user_id?: string
  email?: string
  organization_id?: string
  organization_name?: string
  auth_type?: string
  scopes?: string[]
}

/** GET /v1/emails — one connected mailbox (an email_accounts row). */
export interface WarmblyMailbox {
  id: string
  email?: string
  name?: string | null
  provider?: string | null
  status?: string | null
  warmup?: boolean | null
  warmup_paused_at?: string | null
  warmup_max?: number | null
  warmup_reply_rate?: number | null
  auth_spf?: string | boolean | null
  auth_dkim?: string | boolean | null
  auth_dmarc?: string | boolean | null
  auth_state?: string | null
  send_lifecycle?: string | null
  send_lifecycle_reason?: string | null
  risk_band?: string | null
  last_synced_at?: string | null
  shared_daily_limit?: number | null
  send_recovery_hold?: boolean | null
  send_recovery_reason?: string | null
}

/** GET /v1/campaigns — one campaign row. */
export interface WarmblyCampaign {
  id: string
  name?: string
  status?: string | null
  kind?: string | null
  daily_limit?: number | null
  guardrail_tripped_at?: string | null
  guardrail_reason?: string | null
  last_status_change_at?: string | null
  created_at?: string | null
}

/** GET /v1/analytics/warmup?from&to — warm-up totals for the range (all mailboxes when no email_id). */
export interface WarmblyWarmupAnalytics {
  date_range?: { from?: string; to?: string }
  summary?: {
    total_sent?: number | null
    total_replied?: number | null
    total_received?: number | null
    average_daily?: number | null
    reply_rate?: number | null
    days_active?: number | null
  }
  daily_stats?: unknown[]
}

/** GET /v1/emails/allowance — today's send allowance. */
export interface WarmblyAllowance {
  used?: number | null
  allowance?: number | null
  remaining?: number | null
  basis?: string | null
}
