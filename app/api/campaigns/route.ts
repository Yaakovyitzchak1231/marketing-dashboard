import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getRequestClient } from '@/lib/request-client'



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
    const { data: campaigns, error } = await supabase
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
      .limit(100)
    
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
    
    return NextResponse.json({
      campaigns: processed,
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