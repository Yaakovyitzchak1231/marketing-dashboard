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
  replies_human: number | null
  opportunities: number | null
}

function sumCol<T>(rows: T[], col: keyof T): number | null {
  let total = 0
  let seen = false
  for (const r of rows) {
    const v = r[col]
    if (typeof v === 'number') {
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

  // `ideas` has no `name` column (it is `title`), so the join is dropped and
  // the idea title is resolved from a separate lookup below.
  const { data: campaigns, error: campError } = await supabase
    .from('campaigns')
    .select('id, name, idea_id')
  if (campError) {
    console.error(
      `funnel: campaigns query failed (${campError.code}): ${campError.message}`,
    )
    return NextResponse.json({ error: 'Failed to fetch campaigns' }, { status: 500 })
  }

  const { data: metrics, error: metError } = await supabase
    .from('daily_metrics')
    .select('campaign_id, metric_date, emails_sent, replies_human, opportunities')
    .gte('metric_date', cutoffStr)
  if (metError) {
    console.error(
      `funnel: daily_metrics query failed (${metError.code}): ${metError.message}`,
    )
    return NextResponse.json({ error: 'Failed to fetch metrics' }, { status: 500 })
  }

  const byCampaign = new Map<string, Row[]>()
  for (const m of (metrics ?? []) as Row[]) {
    const list = byCampaign.get(m.campaign_id) ?? []
    list.push(m)
    byCampaign.set(m.campaign_id, list)
  }

  // Idea titles come from a plain lookup: campaigns.idea_id is a real FK but
  // `ideas.title` is the label column, and the collector may not have created
  // a row for an id the campaign still points at.
  const ideaIds = [
    ...new Set(
      (campaigns ?? [])
        .map((c: Record<string, unknown>) => c.idea_id)
        .filter((v: unknown): v is string => typeof v === 'string'),
    ),
  ]
  const ideaTitles = new Map<string, string>()
  if (ideaIds.length > 0) {
    const { data: ideaRows } = await supabase
      .from('ideas')
      .select('id, title')
      .in('id', ideaIds)
    for (const row of (ideaRows ?? []) as { id: string; title: string | null }[]) {
      if (row.title) ideaTitles.set(row.id, row.title)
    }
  }

  const campaignFunnels = (campaigns ?? []).map((c: Record<string, unknown>) => {
    const rows = byCampaign.get(c.id as string) ?? []
    const contacted = sumCol(rows, 'emails_sent')
    const replied = sumCol(rows, 'replies_human')
    // The schema has no positive_replies / meetings_booked / customers_won
    // columns. `opportunities` is the nearest recorded stage, so it is
    // reported as the positive stage; meetings and customers stay null
    // because no collector ever wrote them. Reporting 0 would assert that
    // nobody ever converted, which the database does not say.
    const positive = sumCol(rows, 'opportunities')
    const meetings = null
    const customers = null
    return {
      campaign_id: c.id,
      campaign_name: c.name,
      idea_id: c.idea_id,
      idea_name: typeof c.idea_id === 'string'
        ? ideaTitles.get(c.idea_id) ?? null
        : null,
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
  const ideaNames = ideaTitles
  for (const [cid, rows] of byCampaign) {
    const iid = campaignIdea.get(cid)
    if (!iid) continue
    const entry = byIdea.get(iid) ?? { name: ideaNames.get(iid) ?? 'Unnamed idea', rows: [] }
    entry.rows.push(...rows)
    byIdea.set(iid, entry)
  }
  const ideaFunnels = [...byIdea.entries()].map(([idea_id, { name, rows }]) => {
    const contacted = sumCol(rows, 'emails_sent')
    const replied = sumCol(rows, 'replies_human')
    const positive = sumCol(rows, 'opportunities')
    // Same reasoning as the per-campaign rollup above: no collector has ever
    // written a meeting or customer row, so those stages are unknown.
    const meetings = null
    const customers = null
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
