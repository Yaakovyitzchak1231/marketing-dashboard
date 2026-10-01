import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getRequestClient } from '@/lib/request-client'
import { CAMPAIGN_ROW_LIMIT, verifyCampaignTotal } from '@/lib/campaign-total'

export async function GET(request: NextRequest) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const range = searchParams.get('range') || '7d'
  const sort = searchParams.get('sort') || 'emails_sent'
  const order = searchParams.get('order') || 'desc'
  
  // Calculate date range
  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 7
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - days)
  const cutoffStr = cutoffDate.toISOString().split('T')[0]
  
  try {
    // Three queries, and they are not interchangeable.
    //
    // The rows are the payload: if this fails, the request fails. The two
    // counts are disclosure only: if either fails we report `total: null` and
    // the cap discloses truncation instead. Failing the whole response because
    // a disclosure count was unavailable would be the wrong trade -- it would
    // trade a renderable page for a sentence about a number.
    //
    // They run together because none of them depends on another's result.
    const rowsQuery = supabase
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
          replies_total,
          replies_human,
          replies_autoresponder,
          opportunities,
          bounces,
          open_rate,
          unsubscribe
        )
      `)
      .gte('daily_metrics.metric_date', cutoffStr)
      // Ordering by the qualified path "daily_metrics.metric_date" is invalid
      // PostgREST syntax and returned PGRST100. The embedded column must be
      // named bare, with referencedTable pointing at the join.
      .order('metric_date', { ascending: false, referencedTable: 'daily_metrics' })
      .limit(CAMPAIGN_ROW_LIMIT)

    // `head: true` asks for the count and no body. That is deliberate: with a
    // body, the only number available could be confused for a row count, and
    // the whole question here is which thing was counted. With no body there is
    // nothing to confuse it with.
    //
    // `!inner` is what makes the windowed count a count of campaigns. It
    // promotes the embedded filter to a filter on the top-level resource, so
    // `Content-Range` describes campaigns. Without `!inner` PostgREST would
    // filter the embedded array rather than the parents, and the count would
    // describe the whole portfolio regardless of the window.
    const windowedCountQuery = supabase
      .from('campaigns')
      .select('id, daily_metrics!inner (metric_date)', { count: 'exact', head: true })
      .gte('daily_metrics.metric_date', cutoffStr)

    // No embed and no filter, so its unit is campaigns by construction. Used
    // only to falsify `windowedCount`; see lib/campaign-total.ts.
    const portfolioCountQuery = supabase
      .from('campaigns')
      .select('id', { count: 'exact', head: true })

    const [rowsResult, windowedResult, portfolioResult] = await Promise.all([
      rowsQuery,
      windowedCountQuery,
      portfolioCountQuery,
    ])

    if (rowsResult.error) throw rowsResult.error

    const campaigns = rowsResult.data || []
    
    // Process each campaign to get latest metrics and compute rates
    const processed = (campaigns || []).map(campaign => {
      const metrics = campaign.daily_metrics?.[0] || {}
      
      const sent = metrics.emails_sent ?? null
      const repliesHuman = metrics.replies_human ?? null
      const repliesAuto = metrics.replies_autoresponder ?? null
      const bounces = metrics.bounces ?? null
      const opportunities = metrics.opportunities ?? null
      
      // Compute rates from raw counts - never average a rate
      const replyRate = sent && sent > 0 && repliesHuman !== null
        ? Math.round((repliesHuman / sent) * 10000) / 10000
        : null
      
      const bounceRate = sent && sent > 0 && bounces !== null
        ? Math.round((bounces / sent) * 10000) / 10000
        : null
      
      const openRate = metrics.open_rate ?? null  // Already a rate or null
      const unsubscribe = metrics.unsubscribe ?? null
      
      return {
        id: campaign.id,
        external_id: campaign.external_id,
        name: campaign.name,
        status: campaign.status,
        created_at: campaign.created_at,
        emails_sent: sent,
        replies_human: repliesHuman,
        replies_autoresponder: repliesAuto,
        bounces: bounces,
        opportunities: opportunities,
        reply_rate: replyRate,
        bounce_rate: bounceRate,
        open_rate: openRate,
        unsubscribe: unsubscribe,
        metric_date: metrics.metric_date
      }
    })
    
    // Sort
    processed.sort((a, b) => {
      const aVal = a[sort as keyof typeof a]
      const bVal = b[sort as keyof typeof b]
      if (aVal === null || aVal === undefined) return order === 'asc' ? 1 : -1
      if (bVal === null || bVal === undefined) return order === 'asc' ? -1 : 1
      const cmp = aVal > bVal ? 1 : aVal < bVal ? -1 : 0
      return order === 'asc' ? cmp : -cmp
    })
    
    // The campaign count, or null when its unit is not established. See
    // lib/campaign-total.ts for why the two counts are cross-checked and what
    // each rejection means.
    //
    // It is never `processed.length`. That fallback would set total ===
    // rows.length, so the "Showing N of M campaigns" disclosure would never
    // fire on exactly the truncated lists it exists to announce. When this is
    // null the row limit below discloses truncation instead, so the list can
    // no longer go quietly short.
    const total = verifyCampaignTotal(
      windowedResult.count ?? null,
      portfolioResult.count ?? null,
      processed.length,
    )

    return NextResponse.json({
      campaigns: processed,
      total,
      // Published so the client can tell when the cap bound without needing a
      // count at all. That is the one completeness signal available when every
      // count query fails, so it has to travel with the rows.
      row_limit: CAMPAIGN_ROW_LIMIT,
      range,
      sort,
      order,
    })
  } catch (error) {
    console.error('Campaigns API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch campaigns' },
      { status: 500 }
    )
  }
}