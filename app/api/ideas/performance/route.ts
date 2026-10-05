import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

/**
 * Idea performance: meetings per $100 spent, cost per reply / meeting /
 * customer -- the "what is working" rollup.
 *
 * Spend = sum(costs.amount_usd) for the idea. Outcomes = sums of
 * daily_metrics across the idea's campaigns. Rates recomputed from raw
 * sums; null when the inputs are missing (never zero-filled).
 */

export async function GET(request: NextRequest) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  const { searchParams } = new URL(request.url)
  const range = searchParams.get('range') || '30d'
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().split('T')[0]

  // Column lists follow 002_unified_model.sql: ideas stores its label in
  // `title` (not `name`), daily_metrics has no unique_replies /
  // positive_replies / meetings_booked / customers_won, and costs has no
  // idea_id or spent_at (it is cost_date, and spend is linked by the free-text
  // entity_ref). Outcomes with no stored column stay null rather than zero.
  const { data: ideas, error: ideaError } = await supabase
    .from('ideas')
    .select('id, title, status')
    .order('created_at', { ascending: false })
  if (ideaError) {
    return NextResponse.json({ error: 'Failed to fetch ideas' }, { status: 500 })
  }

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, idea_id')

  const { data: metrics } = await supabase
    .from('daily_metrics')
    .select('campaign_id, replies_human, opportunities')
    .gte('metric_date', cutoffStr)

  // costs carries no idea_id, so spend can only be attributed through
  // entity_ref when it holds an idea id. Anything else is unattributable and
  // leaves the idea's spend unknown instead of defaulting to zero spend.
  const { data: costs } = await supabase
    .from('costs')
    .select('entity_ref, amount_usd')
    .gte('cost_date', cutoffStr)

  const campaignsByIdea = new Map<string, string[]>()
  for (const c of (campaigns ?? []) as { id: string; idea_id: string | null }[]) {
    if (!c.idea_id) continue
    const list = campaignsByIdea.get(c.idea_id) ?? []
    list.push(c.id)
    campaignsByIdea.set(c.idea_id, list)
  }
  const metricsByCampaign = new Map<string, Record<string, unknown>[]>()
  for (const m of (metrics ?? []) as Record<string, unknown>[]) {
    const cid = m.campaign_id as string
    const list = metricsByCampaign.get(cid) ?? []
    list.push(m)
    metricsByCampaign.set(cid, list)
  }
  const spendByIdea = new Map<string, number>()
  for (const c of (costs ?? []) as { entity_ref: string | null; amount_usd: number }[]) {
    // entity_ref holds an idea id when the cost was linked to one. An id we do
    // not recognise is skipped rather than filed under an invented idea.
    if (!c.entity_ref) continue
    spendByIdea.set(c.entity_ref, (spendByIdea.get(c.entity_ref) ?? 0) + Number(c.amount_usd))
  }

  const rows = ((ideas ?? []) as { id: string; title: string | null; status: string }[]).map(idea => {
    const cids = campaignsByIdea.get(idea.id) ?? []
    const spend = spendByIdea.get(idea.id) ?? null

    // Compute sums in a single pass to avoid intermediate array allocations
    let replies: number | null = null
    let seenReplies = false

    for (const cid of cids) {
      const campMetrics = metricsByCampaign.get(cid)
      if (!campMetrics) continue
      for (const m of campMetrics) {
        const v = m.replies_human
        if (typeof v === 'number') {
          replies = (replies ?? 0) + v
          seenReplies = true
        }
      }
    }
    if (!seenReplies) replies = null

    // No collector has ever written a meeting or customer stage, so those two
    // remain unknown. Reporting 0 would assert the idea produced none.
    const meetings = null
    const customers = null

    const per = (outcome: number | null): number | null =>
      outcome !== null && spend !== null && spend > 0
        ? Math.round((outcome / spend) * 10000) / 10000
        : null
    const costPer = (outcome: number | null): number | null =>
      outcome !== null && outcome > 0 && spend !== null
        ? Math.round((spend / outcome) * 100) / 100
        : null

    return {
      idea_id: idea.id,
      idea_name: idea.title ?? null,
      status: idea.status,
      spend_usd: spend,
      replies,
      meetings,
      customers,
      meetings_per_100_usd: per(meetings) !== null ? Math.round((per(meetings) as number) * 100 * 100) / 100 : null,
      cost_per_reply_usd: costPer(replies),
      cost_per_meeting_usd: costPer(meetings),
      cost_per_customer_usd: costPer(customers),
    }
  })

  return NextResponse.json({ range, ideas: rows })
}
