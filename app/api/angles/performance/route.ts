import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

/**
 * Angle performance: human-reply rate per angle from angle_daily_metrics.
 *
 * Human replies = unique_replies minus autoresponder replies (when the
 * collector can separate them; otherwise unique_replies is used and the
 * row is flagged as including autoresponders).
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

  const { data: angles, error } = await supabase
    .from('angles')
    .select('id, name, campaign_id, campaigns(name)')
  if (error) {
    return NextResponse.json({ error: 'Failed to fetch angles' }, { status: 500 })
  }

  // 002_unified_model.sql defines angle_daily_metrics as
  // (angle_id, metric_date, sent, replies_human, replies_autoresponder,
  //  positive_replies, meetings). There is no emails_sent / unique_replies /
  // meetings_booked column, so the query uses the real names and the response
  // keeps the field names the UI already reads.
  const { data: metrics } = await supabase
    .from('angle_daily_metrics')
    .select('angle_id, sent, replies_human, replies_autoresponder, positive_replies, meetings')
    .gte('metric_date', cutoffStr)

  const byAngle = new Map<string, Record<string, unknown>[]>()
  for (const m of (metrics ?? []) as Record<string, unknown>[]) {
    const list = byAngle.get(m.angle_id as string) ?? []
    list.push(m)
    byAngle.set(m.angle_id as string, list)
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

  const rows = ((angles ?? []) as Record<string, unknown>[]).map(a => {
    const mrows = byAngle.get(a.id as string) ?? []
    const sent = sumCol(mrows, 'sent')
    // Human replies are the ones a person wrote; the collector separates
    // autoresponders, so they are excluded rather than folded in.
    const replies = sumCol(mrows, 'replies_human')
    const positive = sumCol(mrows, 'positive_replies')
    const meetings = sumCol(mrows, 'meetings')
    const humanReplyRate =
      sent !== null && sent > 0 && replies !== null
        ? Math.round((replies / sent) * 10000) / 10000
        : null
    return {
      angle_id: a.id,
      angle_name: a.name,
      campaign_name: (a.campaigns as { name?: string } | null)?.name ?? null,
      emails_sent: sent,
      unique_replies: replies,
      positive_replies: positive,
      meetings_booked: meetings,
      human_reply_rate: humanReplyRate !== null && humanReplyRate <= 1 ? humanReplyRate : null,
      attributed: mrows.length > 0,
    }
  })

  rows.sort((a, b) => (b.human_reply_rate ?? -1) - (a.human_reply_rate ?? -1))

  return NextResponse.json({
    range,
    angles: rows,
    note: 'Angles with no attributed metrics are campaigns with multiple angles or no sync yet.',
  })
}
