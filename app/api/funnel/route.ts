import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

/**
 * Funnel: contacted -> replied -> positive -> meeting -> customer,
 * aggregated per campaign and per idea over the requested range.
 *
 * All counts are sums of raw daily_metrics rows; rates are recomputed from
 * those sums, never averaged. A stage with no data is null, not zero.
 */

type Row = {
  campaign_id: string
  metric_date: string
  emails_sent: number | null
  unique_replies: number | null
  positive_replies: number | null
  meetings_booked: number | null
  customers_won: number | null
}

function sum(values: (number | null)[]): number | null {
  let total = 0
  let seen = false
  for (const v of values) {
    if (v !== null && v !== undefined) {
      total += v
      seen = true
    }
  }
  return seen ? total : null
}

function rate(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null
  const r = part / whole
  if (r < 0 || r > 1) return null // >100% is a bug, never a result
  return Math.round(r * 10000) / 10000
}

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

  const { data: campaigns, error: campError } = await supabase
    .from('campaigns')
    .select('id, name, idea_id, ideas(id, name)')
  if (campError) {
    return NextResponse.json({ error: 'Failed to fetch campaigns' }, { status: 500 })
  }

  const { data: metrics, error: metError } = await supabase
    .from('daily_metrics')
    .select('campaign_id, metric_date, emails_sent, unique_replies, positive_replies, meetings_booked, customers_won')
    .gte('metric_date', cutoffStr)
  if (metError) {
    return NextResponse.json({ error: 'Failed to fetch metrics' }, { status: 500 })
  }

  const byCampaign = new Map<string, Row[]>()
  for (const m of (metrics ?? []) as Row[]) {
    const list = byCampaign.get(m.campaign_id) ?? []
    list.push(m)
    byCampaign.set(m.campaign_id, list)
  }

  const campaignFunnels = (campaigns ?? []).map((c: Record<string, unknown>) => {
    const rows = byCampaign.get(c.id as string) ?? []
    const contacted = sum(rows.map(r => r.emails_sent))
    const replied = sum(rows.map(r => r.unique_replies))
    const positive = sum(rows.map(r => r.positive_replies))
    const meetings = sum(rows.map(r => r.meetings_booked))
    const customers = sum(rows.map(r => r.customers_won))
    return {
      campaign_id: c.id,
      campaign_name: c.name,
      idea_id: c.idea_id,
      idea_name: (c.ideas as { name?: string } | null)?.name ?? null,
      contacted,
      replied,
      positive,
      meetings,
      customers,
      reply_rate: rate(replied, contacted),
      positive_rate: rate(positive, replied),
      meeting_rate: rate(meetings, positive),
      close_rate: rate(customers, meetings),
    }
  })

  // Roll up to ideas
  const byIdea = new Map<string, { name: string; rows: Row[] }>()
  const campaignIdea = new Map<string, string>()
  for (const c of (campaigns ?? []) as Record<string, unknown>[]) {
    if (c.idea_id) campaignIdea.set(c.id as string, c.idea_id as string)
  }
  const ideaNames = new Map<string, string>()
  for (const c of (campaigns ?? []) as Record<string, unknown>[]) {
    if (c.idea_id && (c.ideas as { name?: string } | null)?.name) {
      ideaNames.set(c.idea_id as string, (c.ideas as { name: string }).name)
    }
  }
  for (const [cid, rows] of byCampaign) {
    const iid = campaignIdea.get(cid)
    if (!iid) continue
    const entry = byIdea.get(iid) ?? { name: ideaNames.get(iid) ?? 'Unnamed idea', rows: [] }
    entry.rows.push(...rows)
    byIdea.set(iid, entry)
  }
  const ideaFunnels = [...byIdea.entries()].map(([idea_id, { name, rows }]) => {
    const contacted = sum(rows.map(r => r.emails_sent))
    const replied = sum(rows.map(r => r.unique_replies))
    const positive = sum(rows.map(r => r.positive_replies))
    const meetings = sum(rows.map(r => r.meetings_booked))
    const customers = sum(rows.map(r => r.customers_won))
    return {
      idea_id, idea_name: name,
      contacted, replied, positive, meetings, customers,
      reply_rate: rate(replied, contacted),
      positive_rate: rate(positive, replied),
      meeting_rate: rate(meetings, positive),
      close_rate: rate(customers, meetings),
    }
  })

  return NextResponse.json({ range, campaigns: campaignFunnels, ideas: ideaFunnels })
}
