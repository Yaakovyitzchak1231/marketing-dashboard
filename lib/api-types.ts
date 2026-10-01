/**
 * The API contract, as T3 defines it.
 *
 * These types exist so the render path cannot quietly disagree with the API
 * about what a missing value looks like. Every metric is `number | null` and
 * nothing is optional: if the source did not report it, the key is present and
 * `null`. A missing key and a `null` value are different states and the
 * dashboard treats them the same way -- "not reported" -- but only because
 * this file says so explicitly.
 */

/** `GET /api/overview` */
export type Overview = {
  emails_sent: number | null
  replies_human: number | null
  replies_autoresponder: number | null
  bounces: number | null
  opportunities: number | null
  opportunity_value: number | null
  mailbox_count: number | null
  healthy_mailboxes: number | null
  reply_rate: number | null
  bounce_rate: number | null
  /**
   * NOT populated by the Instantly API. `open_count_unique` is zero for every
   * campaign, so this is permanently null -- not zero, not a small number.
   */
  open_rate: number | null
  /** NOT populated by the Instantly API. Permanently null. */
  unsubscribe: number | null
  range: string
  /**
   * When this snapshot was collected, from the `accounts` row itself.
   *
   * `metric_date` is the day the metrics describe; `generated_at` is when the
   * collector wrote them. The freshness line needs the second one. It is null
   * when the row predates the column or the source reported none -- never
   * substituted with `metric_date` or `new Date()`, because either would make
   * a collection look more recent than it is.
   */
  generated_at: string | null
}

/** `GET /api/campaigns` */
export type Campaign = {
  id: string
  external_id: string | null
  name: string
  status: string | null
  created_at: string | null
  emails_sent: number | null
  replies_human: number | null
  replies_autoresponder: number | null
  bounces: number | null
  opportunities: number | null
  reply_rate: number | null
  bounce_rate: number | null
  open_rate: number | null
  unsubscribe: number | null
  metric_date: string | null
}

export type CampaignList = {
  campaigns: Campaign[]
  /**
   * The full count the source knows about, when it reports one. Present only so
   * a truncated list can be labelled as truncated rather than passed off as
   * the whole portfolio.
   */
  total?: number | null
  range: string
  sort: string
  order: string
}

/** One day of `GET /api/campaigns/[id]/trend` */
export type TrendDay = {
  metric_date: string | null
  emails_sent: number | null
  replies_human: number | null
  replies_autoresponder: number | null
  bounces: number | null
  opportunities: number | null
  reply_rate: number | null
  bounce_rate: number | null
  open_rate: number | null
  unsubscribe: number | null
}

export type CampaignTrend = {
  id: string
  external_id: string | null
  name: string
  status: string | null
  created_at: string | null
  trend: TrendDay[]
  range: string
}

/**
 * Data freshness. This is metadata ABOUT the snapshot, not a metric, so it
 * carries no number that could be mistaken for one.
 */
export type Freshness = {
  /** The timestamp the source reported, or null if it reported none. */
  generatedAt: string | null
  /** True when the last collection run failed. */
  collectionFailed: boolean
}
