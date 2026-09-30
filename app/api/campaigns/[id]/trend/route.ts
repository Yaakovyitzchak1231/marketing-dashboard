import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { rateFrom, openRateFrom, unsubRateFrom } from '@/lib/rates'

/**
 * Per-campaign daily trend.
 *
 * Each day is rated independently from that day's raw counts. A rate is never
 * carried forward, never interpolated across a gap, and never averaged -- a
 * day with no collection is a null point in the series, not a zero.
 *
 * Instantly's GET_DAILY_CAMPAIGN_ANALYTICS returns no rows for windows where
 * nothing happened. An absent day is therefore genuinely absent rather than
 * zero, and the collector should write no row for it. Gaps must render as
 * gaps; T8's sparkline needs to be able to tell "no sends" from "no data".
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { searchParams } = new URL(request.url)
  const range = searchParams.get('range') || '30d'

  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 30
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - days)
  const cutoffStr = cutoffDate.toISOString().split('T')[0]

  try {
    const { data: campaign, error } = await supabase
      .from('campaigns')
      .select(`
        id,
        external_id,
        name,
        status,
        created_at,
        daily_metrics!inner (
          metric_date,
          emails_sent,
          replies_unique,
          replies_automatic_unique,
          replies_all,
          bounces,
          opportunities,
          opens_unique,
          unsubscribed,
          open_reported,
          unsub_reported,
          partial
        )
      `)
      .eq('id', id)
      .gte('daily_metrics.metric_date', cutoffStr)
      .order('daily_metrics.metric_date', { ascending: true })
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
      }
      throw error
    }

    const trend = (campaign.daily_metrics || []).map((m: Record<string, unknown>) => {
      const sent = (m.emails_sent as number | null) ?? null
      const partial = Boolean(m.partial)

      const reply = rateFrom({
        numerator: (m.replies_unique as number | null) ?? null,
        denominator: sent,
        denominatorSource: 'emails_sent',
        partial,
      })

      const bounce = rateFrom({
        numerator: (m.bounces as number | null) ?? null,
        denominator: sent,
        denominatorSource: 'emails_sent',
        partial,
      })

      return {
        metric_date: m.metric_date,
        emails_sent: sent,
        replies_unique: (m.replies_unique as number | null) ?? null,
        replies_automatic_unique: (m.replies_automatic_unique as number | null) ?? null,
        replies_all: (m.replies_all as number | null) ?? null,
        bounces: (m.bounces as number | null) ?? null,
        opportunities: (m.opportunities as number | null) ?? null,

        reply_rate: reply.value,
        reply_rate_trusted: reply.trusted,
        reply_rate_reason: reply.reason,
        bounce_rate: bounce.value,
        bounce_rate_trusted: bounce.trusted,
        bounce_rate_reason: bounce.reason,

        // Null for every day on this account: Instantly returns
        // open_count_unique = 0 without having measured opens.
        open_rate: openRateFrom({
          opensUnique: (m.opens_unique as number | null) ?? null,
          reported: Boolean(m.open_reported),
          denominator: sent,
        }),
        unsubscribe_rate: unsubRateFrom({
          unsubscribed: (m.unsubscribed as number | null) ?? null,
          reported: Boolean(m.unsub_reported),
          denominator: sent,
        }),

        partial,
      }
    })

    return NextResponse.json({
      id: campaign.id,
      external_id: campaign.external_id,
      name: campaign.name,
      status: campaign.status,
      created_at: campaign.created_at,
      trend,
      // Day count in the window vs rows actually returned. Unequal means gaps,
      // and T8 must draw a gap rather than connect across it.
      window_days: days,
      returned_days: trend.length,
      has_gaps: trend.length < days,
      range,
    })
  } catch (error) {
    console.error('Campaign trend API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch campaign trend', trend: [], returned_days: 0 },
      { status: 500 }
    )
  }
}
