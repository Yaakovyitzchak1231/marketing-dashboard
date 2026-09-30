import { NextRequest, NextResponse } from 'next/server'
import { getRequestSupabaseClient } from '@/lib/request-supabase'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // This route previously imported the shared BROWSER client from
  // `@/lib/supabase`. On the server that client has no request cookies, so
  // every query went out unauthenticated and RLS returned nothing. Same class
  // of bug as overview and campaigns: the read must carry the caller's
  // session.
  const supabase = await getRequestSupabaseClient(request)
  if (!supabase) {
    return NextResponse.json(
      { error: 'Supabase is not configured' },
      { status: 503 }
    )
  }

  const { id } = await params
  const { searchParams } = new URL(request.url)
  const range = searchParams.get('range') || '30d'
  
  // Calculate date range
  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 30
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - days)
  const cutoffStr = cutoffDate.toISOString().split('T')[0]
  
  try {
    // Get campaign with daily metrics for trend
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
          replies_total,
          replies_human,
          replies_autoresponder,
          opportunities,
          bounces,
          open_rate,
          unsubscribe
        )
      `)
      .eq('id', id)
      .gte('daily_metrics.metric_date', cutoffStr)
      // Ordering by the qualified path "daily_metrics.metric_date" is invalid
      // PostgREST syntax and returns PGRST100. The embedded column is named
      // bare, with referencedTable pointing at the join -- the same pattern
      // app/api/campaigns/route.ts uses.
      .order('metric_date', { ascending: true, referencedTable: 'daily_metrics' })
      .single()
    
    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json(
          { error: 'Campaign not found' },
          { status: 404 }
        )
      }
      throw error
    }
    
    // Process daily metrics for trend
    const trend = (campaign.daily_metrics || []).map((metrics: any) => {
      const sent = metrics.emails_sent ?? null
      const repliesHuman = metrics.replies_human ?? null
      const repliesAuto = metrics.replies_autoresponder ?? null
      const bounces = metrics.bounces ?? null
      const opportunities = metrics.opportunities ?? null
      
      const replyRate = sent && sent > 0 && repliesHuman !== null
        ? Math.round((repliesHuman / sent) * 10000) / 10000
        : null
      
      const bounceRate = sent && sent > 0 && bounces !== null
        ? Math.round((bounces / sent) * 10000) / 10000
        : null
      
      return {
        metric_date: metrics.metric_date,
        emails_sent: sent,
        replies_human: repliesHuman,
        replies_autoresponder: repliesAuto,
        bounces: bounces,
        opportunities: opportunities,
        reply_rate: replyRate,
        bounce_rate: bounceRate,
        open_rate: metrics.open_rate ?? null,
        unsubscribe: metrics.unsubscribe ?? null
      }
    })
    
    return NextResponse.json({
      id: campaign.id,
      external_id: campaign.external_id,
      name: campaign.name,
      status: campaign.status,
      created_at: campaign.created_at,
      trend,
      range
    })
  } catch (error) {
    console.error('Campaign trend API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch campaign trend' },
      { status: 500 }
    )
  }
}