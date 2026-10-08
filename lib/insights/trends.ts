/**
 * Period-over-period rules: this range vs the same-length range before it
 * (DashboardData.previous), plus "sending stalled" from the daily series.
 */
import type { Counts } from '@/lib/dashboard/types'
import { MIN_CONTACTED_FOR_TREND, MIN_SENT_FOR_VOLUME_TREND, STALL_DAYS, VOLUME_DROP_SHARE } from './thresholds'
import { num, ofN, pct, pts, rate, significant, twoProportionZ } from './stats'
import { RULE_IMPACT, mag, type InsightInput, type RankedInsight } from './types'
import { localDate, periodLabel, previousLabel, shortDate } from './util'

function rateTrend(
  d: InsightInput,
  metric: 'replied' | 'positive',
  cur: Counts,
  prev: Counts,
): RankedInsight | null {
  const n1 = cur.contacted
  const n0 = prev.contacted
  const k1 = cur[metric]
  const k0 = prev[metric]
  if (n1 == null || n0 == null || k1 == null || k0 == null) return null
  if (n1 < MIN_CONTACTED_FOR_TREND || n0 < MIN_CONTACTED_FOR_TREND) return null
  const p1 = rate(k1, n1)
  const p0 = rate(k0, n0)
  if (p1 == null || p0 == null) return null
  const z = twoProportionZ(k1, n1, k0, n0)
  if (!significant(z)) return null
  const up = p1 > p0
  const rel = p0 > 0 ? ` (${up ? '+' : '−'}${Math.round(Math.abs(p1 - p0) / p0 * 100)}%)` : ''
  const label = metric === 'replied' ? 'Reply rate' : 'Positive-reply rate'
  const what = metric === 'replied' ? 'replied' : 'became opportunities'
  return {
    id: `trend-${metric === 'replied' ? 'reply' : 'positive'}-${up ? 'up' : 'down'}`,
    severity: up ? 'win' : 'warning',
    title: `${label} ${up ? 'up' : 'down'} to ${pct(p1)} from ${pct(p0)}`,
    detail:
      `${periodLabel(d.range)[0].toUpperCase()}${periodLabel(d.range).slice(1)}: ${ofN(k1, n1)} leads contacted ${what} (${pct(p1)}). ` +
      `${previousLabel(d.range)[0].toUpperCase()}${previousLabel(d.range).slice(1)}: ${ofN(k0, n0)} (${pct(p0)}). ` +
      `Change: ${pts(p1 - p0)}${rel}, bigger than chance at 95% confidence.`,
    action: up
      ? 'Keep what changed this period running and give it more leads.'
      : metric === 'replied'
        ? 'Check what changed: new lead list, new copy, or sending accounts (see deliverability). Roll back the change if you can name it.'
        : 'Look at the latest replies: if people reply but say no, the offer or the list is off, not the deliverability.',
    metric: { label, value: `${pct(p1)} (${pts(p1 - p0)})` },
    impact: (metric === 'replied' ? RULE_IMPACT.replyTrend : RULE_IMPACT.positiveTrend) + mag(Math.abs(p1 - p0) * 1000),
  }
}

export function trendInsights(d: InsightInput): RankedInsight[] {
  const out: RankedInsight[] = []
  const cur = d.totals.counts
  const prev = d.previous?.counts

  if (prev) {
    for (const m of ['replied', 'positive'] as const) {
      const t = rateTrend(d, m, cur, prev)
      if (t) out.push(t)
    }

    // Volume drop: emails sent this period vs previous.
    if (prev.sent != null && cur.sent != null && prev.sent >= MIN_SENT_FOR_VOLUME_TREND && cur.sent <= prev.sent * (1 - VOLUME_DROP_SHARE)) {
      const drop = 1 - cur.sent / prev.sent
      out.push({
        id: 'trend-volume-down',
        severity: 'warning',
        title: `Sending volume fell ${pct(drop)}`,
        detail: `${num(cur.sent)} emails sent in ${periodLabel(d.range)} vs ${num(prev.sent)} in ${previousLabel(d.range)}.`,
        action: 'Check for campaigns that ran out of leads or finished, and for disconnected or paused sending accounts (both listed here).',
        metric: { label: 'Emails sent', value: `${num(cur.sent)} vs ${num(prev.sent)}` },
        impact: RULE_IMPACT.volumeDrop + mag(drop * 100),
      })
    }
  }

  // Stalled: the last STALL_DAYS finished days sent nothing, after earlier days that did.
  const today = localDate(d.generatedAt, d.range.timezone)
  const done = [...d.daily]
    .filter((p) => today == null || p.date < today)
    .sort((a, b) => a.date.localeCompare(b.date))
  let trailing = 0
  for (let i = done.length - 1; i >= 0 && done[i].sent === 0; i--) trailing++
  const earlier = done.slice(0, done.length - trailing)
  const lastSend = [...earlier].reverse().find((p) => (p.sent ?? 0) > 0)
  if (trailing >= STALL_DAYS && lastSend) {
    const anyActive = d.campaigns.some((c) => c.status === 'active')
    out.push({
      id: 'sending-stalled',
      severity: anyActive ? 'critical' : 'warning',
      title: `No emails sent since ${shortDate(lastSend.date)}`,
      detail:
        `${trailing} days in a row with 0 emails sent (today not counted). The last sending day, ${shortDate(lastSend.date)}, sent ${num(lastSend.sent ?? 0)}.` +
        (anyActive ? ' At least one campaign is still marked active, so something is blocking it.' : ' No campaign is marked active.'),
      action: anyActive
        ? 'Open Instantly: check the active campaign for "no leads left", its schedule, and its sending accounts for errors.'
        : 'Launch or resume a campaign; nothing is scheduled to send.',
      impact: RULE_IMPACT.sendingStalled + mag(trailing),
    })
  }

  return out
}
