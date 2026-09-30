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
  const supabase = getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  const { searchParams } = new URL(request.url)
  const range = searchParams.get('range') || '30d'
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().split('T')[0]

  const { data: ideas, error: ideaError } = await supabase
    .from('ideas')
    .select('id, name, status')
    .order('created_at', { ascending: false })
  if (ideaError) {
    return NextResponse.json({ error: 'Failed to fetch ideas' }, { status: 500 })
  }

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, idea_id')

  const { data: metrics } = await supabase
    .from('daily_metrics')
    .select('campaign_id, emails_sent, unique_replies, positive_replies, meetings_booked, customers_won')
    .gte('metric_date', cutoffStr)

  const { data: costs } = await supabase
    .from('costs')
    .select('idea_id, amount_usd')
    .gte('spent_at', cutoffStr)

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
  for (const c of (costs ?? []) as { idea_id: string | null; amount_usd: number }[]) {
    if (!c.idea_id) continue
    spendByIdea.set(c.idea_id, (spendByIdea.get(c.idea_id) ?? 0) + Number(c.amount_usd))
  }

  const sumCol = (rows: Record<string, unknown>[], col: string): number | null => {
    let total = 0
    let seen = false
    for (const r of rows) {
      const v = r[col]
      if (typeof v === 'number') { total += v; seen = true }
    }
    return seen ? total : null
  }

  const rows = ((ideas ?? []) as { id: string; name: string; status: string }[]).map(idea => {
    const cids = campaignsByIdea.get(idea.id) ?? []
    const mrows = cids.flatMap(cid => metricsByCampaign.get(cid) ?? []) as Record<string, unknown>[]
    const spend = spendByIdea.get(idea.id) ?? null
    const replies = sumCol(mrows, 'unique_replies')
    const meetings = sumCol(mrows, 'meetings_booked')
    const customers = sumCol(mrows, 'customers_won')

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
      idea_name: idea.name,
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
