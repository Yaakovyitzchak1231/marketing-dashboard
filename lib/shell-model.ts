import type {
  Overview,
  CampaignList,
  CampaignTrend,
  Freshness,
} from '@/lib/api-types'
import { rateIsPlausible, isUnavailable } from '@/lib/format'
import type { Kpi } from '@/components/kpi-row'
import type { CampaignRow } from '@/components/campaign-table'
import type { SenderHealth } from '@/components/sender-health'
import type { TrendPoint } from '@/components/trend-chart'

/**
 * The shell model: the single seam between the API contract and the render
 * path.
 *
 * Every component receives values from THIS function and never from a raw
 * fetch. That is what makes the honesty rules testable without a DOM, and what
 * keeps a `?? 0` out of the components -- there is exactly one place a null
 * could be coerced, and it is here, and it is not.
 *
 * The function is pure and total: it cannot fail, it cannot fetch, and it
 * never invents a figure. Given the same responses it always produces the same
 * model, so a discrepancy between what was stored and what is on screen is
 * always a bug in one of the two -- never a race.
 */

export type ShellModel = {
  kpis: Kpi[]
  campaigns: CampaignRow[]
  /**
   * The source's full count, when it reports one and it exceeds what we hold.
   * Null means "either the list is complete or the source did not say".
   */
  campaignTotal: number | null
  senderHealth: SenderHealth
  trend: TrendPoint[]
  /** The chart could not be loaded. Distinct from "no history yet". */
  trendError: boolean
  /**
   * The overview route did not answer with a usable payload. Distinct from an
   * overview whose individual metrics are null: a failed fetch is an outage,
   * an all-null overview is a source that reported nothing. They are different
   * facts and the page says different things about each.
   */
  overviewUnavailable: boolean
  /**
   * At least one reported rate is above 100% and therefore not a measurement.
   * The shell surfaces this as a stated caveat rather than silently dropping
   * the number.
   */
  unreliableReplyRate: boolean
  freshness: Freshness
}

/**
 * The KPI row, in the order a reader wants them.
 *
 * Open rate and unsubscribe are included even though they are permanently
 * null. That is the point: their absence from the row would be a quiet way to
 * hide that the API never reports them, and a reader who cannot see the gap
 * will assume nobody checked.
 */
function buildKpis(o: Overview): Kpi[] {
  return [
    { key: 'emails_sent', label: 'Emails sent', value: o.emails_sent, kind: 'count' },
    { key: 'replies_human', label: 'Replies (human)', value: o.replies_human, kind: 'count' },
    { key: 'reply_rate', label: 'Reply rate', value: o.reply_rate, kind: 'rate' },
    { key: 'bounce_rate', label: 'Bounce rate', value: o.bounce_rate, kind: 'rate' },
    { key: 'opportunities', label: 'Opportunities', value: o.opportunities, kind: 'count' },
    { key: 'opportunity_value', label: 'Opportunity value', value: o.opportunity_value, kind: 'currency' },
    { key: 'open_rate', label: 'Open rate', value: o.open_rate, kind: 'rate' },
    { key: 'unsubscribe', label: 'Unsubscribes', value: o.unsubscribe, kind: 'count' },
  ]
}

/**
 * A row is a `CampaignRow` with the identity fields the table needs. The metric
 * fields are carried straight across -- no recomputation, no defaulting. If the
 * API sent null, null is what arrives here.
 */
function toCampaignRow(c: CampaignList['campaigns'][number]): CampaignRow {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    emails_sent: c.emails_sent,
    replies_human: c.replies_human,
    replies_autoresponder: c.replies_autoresponder,
    bounces: c.bounces,
    opportunities: c.opportunities,
    reply_rate: c.reply_rate,
    bounce_rate: c.bounce_rate,
    open_rate: c.open_rate,
    unsubscribe: c.unsubscribe,
    metric_date: c.metric_date,
  }
}

/**
 * Does any reported rate exceed what a rate can be?
 *
 * This is the 333% / 450% autoresponder artefact. It is detected, not fixed:
 * the underlying calculation belongs to the data layer, and the shell's job is
 * to refuse to present the number as a measurement.
 */
function anyImplausibleRate(rows: CampaignRow[]): boolean {
  return rows.some(
    (r) =>
      (!isUnavailable(r.reply_rate) && !rateIsPlausible(r.reply_rate)) ||
      (!isUnavailable(r.bounce_rate) && !rateIsPlausible(r.bounce_rate)),
  )
}

/**
 * The trend series, oldest first.
 *
 * A day whose `emails_sent` is null is kept as a null point rather than being
 * dropped or zero-filled, so the chart can render a gap instead of inventing a
 * dip. Days with no date at all cannot be placed on an axis and are dropped.
 */
function toTrendPoints(trend: CampaignTrend | null): TrendPoint[] {
  if (!trend) return []
  return trend.trend
    .filter((d) => !isUnavailable(d.metric_date))
    .map((d) => ({ day: d.metric_date as string, value: d.emails_sent }))
    .sort((a, b) => a.day.localeCompare(b.day))
}

export function buildShellModel(input: {
  overview: Overview | null
  campaigns: CampaignList | null
  trend: CampaignTrend | null
  freshness: Freshness
  trendFailed?: boolean
}): ShellModel {
  const { overview, campaigns, trend, freshness, trendFailed = false } = input

  // A failed or absent overview is NOT the same as a zeroed one. Every cell
  // becomes null and the row renders as entirely "not reported" -- which is
  // what the API actually told us.
  const rows: CampaignRow[] = (campaigns?.campaigns ?? []).map(toCampaignRow)

  const o = overview
  const senderHealth: SenderHealth = {
    mailbox_count: o?.mailbox_count ?? null,
    healthy_mailboxes: o?.healthy_mailboxes ?? null,
    // The API does not report these two; they stay null rather than 0.
    warmup_avg: null,
    daily_limit: null,
    setup_pending: null,
  }

  const campaignTotal =
    !isUnavailable(campaigns?.total) && (campaigns as CampaignList).total! > rows.length
      ? (campaigns as CampaignList).total!
      : null

  return {
    kpis: o
      ? buildKpis(o)
      : [
          { key: 'emails_sent', label: 'Emails sent', value: null, kind: 'count' },
          { key: 'replies_human', label: 'Replies (human)', value: null, kind: 'count' },
          { key: 'reply_rate', label: 'Reply rate', value: null, kind: 'rate' },
          { key: 'bounce_rate', label: 'Bounce rate', value: null, kind: 'rate' },
          { key: 'opportunities', label: 'Opportunities', value: null, kind: 'count' },
          { key: 'opportunity_value', label: 'Opportunity value', value: null, kind: 'currency' },
          { key: 'open_rate', label: 'Open rate', value: null, kind: 'rate' },
          { key: 'unsubscribe', label: 'Unsubscribes', value: null, kind: 'count' },
        ],
    campaigns: rows,
    campaignTotal,
    senderHealth,
    trend: toTrendPoints(trend),
    trendError: trendFailed,
    overviewUnavailable: o === null,
    unreliableReplyRate: anyImplausibleRate(rows),
    freshness,
  }
}
