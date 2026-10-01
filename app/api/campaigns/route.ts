import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getRequestClient } from '@/lib/request-client'

// A cap on how many rows one response carries -- NOT a reporting window. The
// visible rows are the newest `CAMPAIGN_ROW_LIMIT` campaigns in range; nothing
// about the portfolio is scoped away by it. The only thing that discloses when
// this cap actually truncated the list is the `total` we ask for alongside the
// rows, which PostgREST computes before `limit` is applied. Without that count
// a short list is indistinguishable from a complete one, which is exactly the
// silent-truncation bug this dashboard exists to fix.
const CAMPAIGN_ROW_LIMIT = 100

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
    // Get campaigns with their latest metrics
    // `count: 'exact'` is asked for on THIS query, not a second one. PostgREST
    // returns the count of rows matching the filter before `limit` is applied,
    // so it describes the same population the rows were drawn from. A separate
    // count query could disagree with this filter and the response would then
    // contradict itself.
    const { data: campaigns, error, count } = await supabase
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
      `, { count: 'exact' })
      .gte('daily_metrics.metric_date', cutoffStr)
      // Ordering by the qualified path "daily_metrics.metric_date" is invalid
      // PostgREST syntax and returned PGRST100. The embedded column must be
      // named bare, with referencedTable pointing at the join.
      .order('metric_date', { ascending: false, referencedTable: 'daily_metrics' })
      .limit(CAMPAIGN_ROW_LIMIT)
    
    if (error) throw error
    
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
    
    // The count the driver reported, or null when it reported no real number.
    // null means "the source did not say" -- it is deliberately NOT
    // `processed.length`. Falling back to the row count would set
    // total === rows.length, so the "Showing N of M campaigns" disclosure would
    // never fire on exactly the truncated lists it exists to announce. Better to
    // disclose nothing than to claim nothing was cut.
    //
    // `?? null` alone is not enough: supabase-js derives `count` with
    // `parseInt(contentRange[1])`, so a `Content-Range: */*` header yields NaN,
    // which is not nullish. Today `NextResponse.json` happens to serialize NaN as
    // null -- and a truthfulness guarantee that rests on the serializer is
    // backwards. `Number.isFinite` is the same guard lib/format.ts applies to
    // every value it prints, for the same reason. It is not a falsy check either:
    // a count of 0 is a measurement (no campaigns match the window) and must
    // survive.
    const total = count !== null && Number.isFinite(count) ? count : null

    return NextResponse.json({
      campaigns: processed,
      total,
      range,
      sort,
      order
    })
  } catch (error) {
    console.error('Campaigns API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch campaigns' },
      { status: 500 }
    )
  }
}