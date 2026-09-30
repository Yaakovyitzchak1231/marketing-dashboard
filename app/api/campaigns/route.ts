import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { rateFrom, openRateFrom, unsubRateFrom } from '@/lib/rates'

const COLUMNS = `
  id,
  external_id,
  name,
  status,
  created_at,
  daily_metrics!inner (
    metric_date,
    emails_sent,
    contacted_count,
    new_leads_contacted,
    leads_count,
    replies_unique,
    replies_automatic_unique,
    replies_all,
    bounces,
    opportunities,
    opportunity_value,
    opens_unique,
    unsubscribed,
    open_reported,
    unsub_reported,
    partial,
    rate_trusted,
    rate_untrusted_reason
  )
`

/**
 * Per-campaign table.
 *
 * Each row carries its own raw counts plus a trust flag and a reason, so
 * @build-copy can pick the right copy without the UI holding a threshold of
 * its own. Two real campaigns on this account currently rate as NULL:
 *
 *   IRS Penalty Back   2 sent, 9 unique replies  -> numerator > denominator
 *   PB Signups (TEST)  3 sent, 10 unique replies -> numerator > denominator
 *
 * These are not autoresponder problems. No denominator in the payload fixes
 * them: contacted_count and new_leads_contacted are equal to or smaller than
 * emails_sent, and leads_count (the largest, 4) is still below 9. Re-queried
 * with an explicit date window; identical. So the rate is suppressed and the
 * row says why, rather than rendering 450%.
 *
 * A campaign missing from this response is NOT a campaign with zero activity.
 * If a collection failed, the row is absent and `partial_count` from
 * /api/overview tells the UI to render @build-copy's partial-data banner.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const range = searchParams.get('range') || '7d'
  const sort = searchParams.get('sort') || 'emails_sent'
  const order = searchParams.get('order') || 'desc'

  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 7
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - days)
  const cutoffStr = cutoffDate.toISOString().split('T')[0]

  try {
    const { data: campaigns, error } = await supabase
      .from('campaigns')
      .select(COLUMNS)
      .gte('daily_metrics.metric_date', cutoffStr)
      .order('daily_metrics.metric_date', { ascending: false })
      .limit(100)

    if (error) throw error

    const processed = (campaigns || []).map(campaign => {
      const m = (campaign.daily_metrics || [])[0] || {}

      const sent = m.emails_sent ?? null
      const partial = Boolean(m.partial)

      const reply = rateFrom({
        numerator: m.replies_unique ?? null,
        denominator: sent,
        denominatorSource: 'emails_sent',
        partial,
      })

      const bounce = rateFrom({
        numerator: m.bounces ?? null,
        denominator: sent,
        denominatorSource: 'emails_sent',
        partial,
      })

      const openRate = openRateFrom({
        opensUnique: m.opens_unique ?? null,
        reported: Boolean(m.open_reported),
        denominator: sent,
      })

      const unsubRate = unsubRateFrom({
        unsubscribed: m.unsubscribed ?? null,
        reported: Boolean(m.unsub_reported),
        denominator: sent,
      })

      return {
        id: campaign.id,
        external_id: campaign.external_id,
        name: campaign.name,
        status: campaign.status,
        created_at: campaign.created_at,

        emails_sent: sent,
        contacted: m.contacted_count ?? null,
        new_leads_contacted: m.new_leads_contacted ?? null,
        leads_count: m.leads_count ?? null,

        // Raw and independent. `replies_unique - replies_automatic_unique` is
        // -2 on the TapDash campaign and must never be computed.
        replies_unique: m.replies_unique ?? null,
        replies_automatic_unique: m.replies_automatic_unique ?? null,
        replies_all: m.replies_all ?? null,

        bounces: m.bounces ?? null,
        opportunities: m.opportunities ?? null,
        opportunity_value: m.opportunity_value ?? null,
        opens_unique: m.opens_unique ?? null,
        unsubscribed: m.unsubscribed ?? null,

        reply_rate: reply.value,
        reply_rate_trusted: reply.trusted,
        reply_rate_denominator: reply.denominator,
        reply_rate_denominator_source: reply.denominatorSource,
        reply_rate_reason: reply.reason,

        bounce_rate: bounce.value,
        bounce_rate_trusted: bounce.trusted,
        bounce_rate_reason: bounce.reason,

        open_rate: openRate,
        unsubscribe_rate: unsubRate,
        open_reported: Boolean(m.open_reported),
        unsub_reported: Boolean(m.unsub_reported),

        partial,
        metric_date: m.metric_date,
      }
    })

    // Sort with nulls last in both directions. A null is not a small number.
    processed.sort((a, b) => {
      const aVal = a[sort as keyof typeof a]
      const bVal = b[sort as keyof typeof b]
      const aNull = aVal === null || aVal === undefined
      const bNull = bVal === null || bVal === undefined
      if (aNull && bNull) return 0
      if (aNull) return 1
      if (bNull) return -1
      const cmp = aVal > bVal ? 1 : aVal < bVal ? -1 : 0
      return order === 'asc' ? cmp : -cmp
    })

    return NextResponse.json({
      campaigns: processed,
      // How many rows actually rendered. Compared against
      // /api/overview's campaigns_inventory_count this exposes a partial run.
      returned: processed.length,
      range,
      sort,
      order,
    })
  } catch (error) {
    console.error('Campaigns API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch campaigns', campaigns: [], returned: 0 },
      { status: 500 }
    )
  }
}
