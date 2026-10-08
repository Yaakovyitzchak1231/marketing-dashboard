/**
 * Raw Instantly API v2 response shapes, as documented in the OpenAPI spec
 * (https://api.instantly.ai/openapi/api_v2.json) and confirmed against live
 * read-only responses on 2026-10-08. Every numeric field is optional here on
 * purpose: the mappers treat a missing field as "not reported" (null), never 0.
 */

/** GET /campaigns item. https://developer.instantly.ai/api-reference/campaign/list-campaign */
export interface ApiCampaign {
  id: string
  name?: string
  /** 0 Draft, 1 Active, 2 Paused, 3 Completed, 4 Running Subsequences, -99 Account Suspended, -1 Accounts Unhealthy, -2 Bounce Protect */
  status?: number
  open_tracking?: boolean | null
  link_tracking?: boolean | null
  timestamp_created?: string
  sequences?: Array<{
    steps?: Array<{
      type?: string
      delay?: number
      variants?: Array<{ subject?: string | null; body?: string; v_disabled?: boolean }>
    }>
  }>
}

/** Fields shared by /campaigns/analytics (per campaign) and /campaigns/analytics/overview. */
export interface ApiAnalyticsCounts {
  emails_sent_count?: number
  /** Live: equals emails_sent_count — it counts sends, not people. Not used. */
  contacted_count?: number
  /** Distinct leads whose sequence started (step 1 sent) in the range. */
  new_leads_contacted_count?: number
  open_count?: number
  open_count_unique?: number
  link_click_count?: number
  link_click_count_unique?: number
  reply_count?: number
  /** First reply per lead. Docs: "Excludes automatic replies." */
  reply_count_unique?: number
  reply_count_automatic?: number
  reply_count_automatic_unique?: number
  bounced_count?: number
  unsubscribed_count?: number
  completed_count?: number
  total_opportunities?: number
  total_opportunity_value?: number
}

/** GET /campaigns/analytics item. https://developer.instantly.ai/api-reference/campaign/get-campaigns-analytics */
export interface ApiCampaignAnalytics extends ApiAnalyticsCounts {
  campaign_id: string
  campaign_name?: string
  campaign_status?: number
  campaign_is_evergreen?: boolean
  leads_count?: number
}

/** GET /campaigns/analytics/overview. https://developer.instantly.ai/api-reference/campaign/get-campaigns-analytics-overview */
export interface ApiAnalyticsOverview extends ApiAnalyticsCounts {
  total_interested?: number
  total_meeting_booked?: number
  total_meeting_completed?: number
  total_closed?: number
}

/** GET /campaigns/analytics/daily item. Days with no activity are omitted. https://developer.instantly.ai/api-reference/campaign/get-daily-campaign-analytics */
export interface ApiDailyRow {
  date: string
  sent?: number
  contacted?: number
  new_leads_contacted?: number
  opened?: number
  unique_opened?: number
  replies?: number
  unique_replies?: number
  replies_automatic?: number
  unique_replies_automatic?: number
  clicks?: number
  unique_clicks?: number
  opportunities?: number
  unique_opportunities?: number
}

/** GET /campaigns/analytics/steps item. step/variant are 0-based strings; null rows = undetermined. https://developer.instantly.ai/api-reference/campaign/get-campaign-steps-analytics */
export interface ApiStepRow {
  step: string | null
  variant: string | null
  sent?: number
  opened?: number
  unique_opened?: number
  replies?: number
  unique_replies?: number
  replies_automatic?: number
  unique_replies_automatic?: number
  clicks?: number
  unique_clicks?: number
  opportunities?: number
  unique_opportunities?: number
  meetings_booked?: number
  won?: number
}

/** GET /accounts item. https://developer.instantly.ai/api-reference/account/list-account */
export interface ApiAccount {
  email: string
  /** 1 Active, 2 Paused, 3 Maintenance, -1 Connection Error, -2 Soft Bounce Error, -3 Sending Error */
  status?: number
  daily_limit?: number | null
  warmup_status?: number
  stat_warmup_score?: number | null
}

/** GET /accounts/analytics/daily item. Needs the `emails` filter. https://developer.instantly.ai/api-reference/account/get-daily-account-analytics */
export interface ApiAccountDailyRow {
  date: string
  email_account: string
  sent?: number
  bounced?: number
  contacted?: number
  new_leads_contacted?: number
  unique_replies?: number
  unique_replies_automatic?: number
}

/** POST /leads/list item. https://developer.instantly.ai/api-reference/lead/list-leads */
export interface ApiLead {
  id: string
  email?: string | null
  first_name?: string | null
  last_name?: string | null
  company_name?: string | null
  campaign?: string | null
  /** 0 OOO, 1 Interested, 2 Meeting Booked, 3 Meeting Completed, 4 Won, -1 Not Interested, -2 Wrong Person, -3 Lost, -4 No Show; other values = custom labels */
  lt_interest_status?: number | null
  email_reply_count?: number
  timestamp_last_reply?: string | null
  timestamp_last_contact?: string | null
}

/** GET /emails item (preview_only=true). Rate limit: 20 requests/minute. https://developer.instantly.ai/api-reference/email/list-email */
export interface ApiEmail {
  id: string
  lead?: string | null
  campaign_id?: string | null
  /** 1 Sent from campaign, 2 Received, 3 Sent (manual), 4 Scheduled */
  ue_type?: number | null
  timestamp_email?: string
  timestamp_created?: string
  subject?: string
  content_preview?: string | null
  thread_id?: string | null
}
