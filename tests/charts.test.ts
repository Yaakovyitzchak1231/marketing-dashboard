import { describe, it, expect } from 'vitest'
import {
  safeRate,
  humanReplyRate,
  buildReplyTrend,
  replyRateIsUnreliable,
  sumKnown,
  opportunityValueSummary,
  senderHealthSummary,
  buildScale,
  buildLinePath,
  contiguousSegments,
} from '@/lib/charts'

// ---------------------------------------------------------------------------
// safeRate — the ONLY place a rate is ever produced.
// ---------------------------------------------------------------------------
describe('safeRate', () => {
  it('divides numerator by denominator', () => {
    expect(safeRate(8, 100)).toBe(0.08)
  })

  it('returns null when the numerator is null (the API did not say)', () => {
    expect(safeRate(null, 100)).toBeNull()
  })

  it('returns null when the denominator is null', () => {
    expect(safeRate(8, null)).toBeNull()
  })

  it('returns null when the denominator is 0 — never Infinity, never 0', () => {
    expect(safeRate(0, 0)).toBeNull()
    expect(safeRate(5, 0)).toBeNull()
  })

  it('returns null when the denominator is negative (defensive, data bug)', () => {
    expect(safeRate(5, -10)).toBeNull()
  })

  it('treats a genuine zero numerator as 0.0, distinct from null', () => {
    expect(safeRate(0, 100)).toBe(0)
    expect(safeRate(0, 100)).not.toBeNull()
  })

  it('rounds to 4dp so rendering never shows float noise', () => {
    expect(safeRate(1, 3)).toBe(0.3333)
    expect(safeRate(2, 3)).toBe(0.6667)
  })
})

// ---------------------------------------------------------------------------
// humanReplyRate — replies_human ONLY. Never replies_total.
// ---------------------------------------------------------------------------
describe('humanReplyRate', () => {
  it('uses human replies', () => {
    expect(humanReplyRate(100, 8, 2)).toBe(0.08)
  })

  it('is unaffected by autoresponders — the 333%/450% defect', () => {
    // 9 human + 2 auto on 2 sent: the contaminated figure is 550%.
    // The human-only figure is a real 4.5 -> but 4.5 > 1 is still impossible,
    // so the rate itself must be flagged unreliable, not silently shown.
    const rate = humanReplyRate(2, 9, 0)
    expect(rate).toBe(4.5)
    expect(replyRateIsUnreliable(rate)).toBe(true)
  })

  it('returns null when human replies are unknown even if autoresponders are known', () => {
    expect(humanReplyRate(100, null, 5)).toBeNull()
  })

  it('returns null when emails sent is 0', () => {
    expect(humanReplyRate(0, 0, 0)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// replyRateIsUnreliable — a rate above 100% is always a bug, never a result.
// ---------------------------------------------------------------------------
describe('replyRateIsUnreliable', () => {
  it('flags a rate above 1', () => {
    expect(replyRateIsUnreliable(1.5)).toBe(true)
    expect(replyRateIsUnreliable(3.33)).toBe(true)
    expect(replyRateIsUnreliable(4.5)).toBe(true)
  })

  it('does not flag a plausible rate', () => {
    expect(replyRateIsUnreliable(0.0419)).toBe(false)
    expect(replyRateIsUnreliable(1)).toBe(false)
    expect(replyRateIsUnreliable(0)).toBe(false)
  })

  it('does not flag a missing rate (missing is not unreliable, it is missing)', () => {
    expect(replyRateIsUnreliable(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// sumKnown — a total is unknown if any part is unknown. No ?? 0.
// ---------------------------------------------------------------------------
describe('sumKnown', () => {
  it('sums known values', () => {
    expect(sumKnown([1, 2, 3])).toBe(6)
  })

  it('returns null when ANY value is null, because a partial sum understates the truth', () => {
    expect(sumKnown([1, null, 3])).toBeNull()
  })

  it('returns null for an empty list — an empty list is not a zero total', () => {
    expect(sumKnown([])).toBeNull()
  })

  it('sums a genuine all-zero list to 0', () => {
    expect(sumKnown([0, 0])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// buildReplyTrend — per-day rates from raw counts, plus a period rate that is
// recomputed from summed raw counts and NEVER an average of daily rates.
// ---------------------------------------------------------------------------
describe('buildReplyTrend', () => {
  const days = [
    { metric_date: '2026-09-28', emails_sent: 100, replies_human: 1, replies_autoresponder: 0 },
    { metric_date: '2026-09-29', emails_sent: 100, replies_human: 9, replies_autoresponder: 0 },
  ]

  it('computes each day from that day raw counts', () => {
    const t = buildReplyTrend(days)
    expect(t.points).toHaveLength(2)
    expect(t.points[0].reply_rate).toBe(0.01)
    expect(t.points[1].reply_rate).toBe(0.09)
  })

  it('recomputes the period rate from summed raw counts, not the mean of daily rates', () => {
    // mean of 0.01 and 0.09 is 0.05; the true rate is 10/200 = 0.05 too here.
    // Use asymmetric sent counts where the two answers differ.
    const asym = [
      { metric_date: '2026-09-28', emails_sent: 1000, replies_human: 10, replies_autoresponder: 0 },
      { metric_date: '2026-09-29', emails_sent: 10, replies_human: 5, replies_autoresponder: 0 },
    ]
    const t = buildReplyTrend(asym)
    // mean of rates = (0.01 + 0.5) / 2 = 0.255   <- WRONG
    // summed counts = 15 / 1010 = 0.014851... <- CORRECT
    expect(t.period?.reply_rate).toBe(0.0149)
    expect(t.period?.reply_rate).not.toBe(0.255)
    expect(t.period?.emails_sent).toBe(1010)
    expect(t.period?.replies_human).toBe(15)
  })

  it('marks the period unreliable when any day is arithmetically impossible', () => {
    const bad = [
      { metric_date: '2026-09-28', emails_sent: 100, replies_human: 1, replies_autoresponder: 0 },
      { metric_date: '2026-09-29', emails_sent: 2, replies_human: 9, replies_autoresponder: 0 },
    ]
    const t = buildReplyTrend(bad)
    // summed = 10/102 = 0.098039 -> 0.098 — plausible-looking, but day 2 alone is 450%.
    expect(t.period?.reply_rate).toBe(0.098)
    expect(t.period?.unreliable).toBe(true)
    expect(t.points[1].unreliable).toBe(true)
    expect(t.points[0].unreliable).toBe(false)
  })

  it('returns an empty trend for no history, not a zero-filled one', () => {
    const t = buildReplyTrend([])
    expect(t.points).toEqual([])
    expect(t.period).toBeNull()
    expect(t.isEmpty).toBe(true)
  })

  it('keeps a null day as a gap — it must not become 0', () => {
    const withGap = [
      { metric_date: '2026-09-28', emails_sent: 100, replies_human: 1, replies_autoresponder: 0 },
      { metric_date: '2026-09-29', emails_sent: null, replies_human: null, replies_autoresponder: null },
      { metric_date: '2026-09-30', emails_sent: 100, replies_human: 2, replies_autoresponder: 0 },
    ]
    const t = buildReplyTrend(withGap)
    expect(t.points[1].reply_rate).toBeNull()
    expect(t.points[1].emails_sent).toBeNull()
    // The period total is unknown because one day is unknown.
    expect(t.period).toBeNull()
  })

  it('sorts points by date ascending regardless of input order', () => {
    const t = buildReplyTrend([
      { metric_date: '2026-09-30', emails_sent: 100, replies_human: 2, replies_autoresponder: 0 },
      { metric_date: '2026-09-28', emails_sent: 100, replies_human: 1, replies_autoresponder: 0 },
    ])
    expect(t.points.map((p) => p.metric_date)).toEqual(['2026-09-28', '2026-09-30'])
  })

  it('de-duplicates a repeated date so a re-collected day is not double counted', () => {
    const dup = [
      { metric_date: '2026-09-28', emails_sent: 100, replies_human: 1, replies_autoresponder: 0 },
      { metric_date: '2026-09-28', emails_sent: 100, replies_human: 1, replies_autoresponder: 0 },
    ]
    expect(buildReplyTrend(dup).points).toHaveLength(1)
  })

  it('exposes open_rate as null and is never given a value to plot', () => {
    // The Instantly API cannot report open_rate; the chart must not invent one.
    const t = buildReplyTrend(days)
    expect(t.points[0].open_rate).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Opportunity value — its own dimension, never folded into revenue.
// ---------------------------------------------------------------------------
describe('opportunityValueSummary', () => {
  it('reports open value and the open count it is derived from', () => {
    const s = opportunityValueSummary({ openValue: 1000, openCount: 3 })
    expect(s.open_value).toBe(1000)
    expect(s.open_count).toBe(3)
  })

  it('does not label open pipeline value as revenue', () => {
    const s = opportunityValueSummary({ openValue: 1000, openCount: 3 })
    expect(s.is_revenue).toBe(false)
  })

  it('computes mean value per open opportunity from raw counts', () => {
    const s = opportunityValueSummary({ openValue: 1000, openCount: 4 })
    expect(s.value_per_opportunity).toBe(250)
  })

  it('returns null mean when the count is zero — no division by zero', () => {
    expect(opportunityValueSummary({ openValue: 1000, openCount: 0 }).value_per_opportunity).toBeNull()
  })

  it('renders a null open value as null, never as $0', () => {
    const s = opportunityValueSummary({ openValue: null, openCount: 3 })
    expect(s.open_value).toBeNull()
    expect(s.value_per_opportunity).toBeNull()
  })

  it('computes closed value only when BOTH open and total value are known', () => {
    expect(opportunityValueSummary({ openValue: 400, openCount: 1, totalValue: 1000 }).closed_value).toBe(600)
    expect(opportunityValueSummary({ openValue: 400, openCount: 1 }).closed_value).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Sender health — per mailbox, from raw counts.
// ---------------------------------------------------------------------------
describe('senderHealthSummary', () => {
  it('computes the healthy share from raw counts', () => {
    const s = senderHealthSummary({ total: 5, healthy: 4 })
    expect(s.healthy_rate).toBe(0.8)
    expect(s.healthy).toBe(4)
    expect(s.total).toBe(5)
  })

  it('returns null when mailbox_count is 0 — an empty fleet is not a 0% fleet', () => {
    const s = senderHealthSummary({ total: 0, healthy: 0 })
    expect(s.healthy_rate).toBeNull()
  })

  it('returns null when the healthy count is unknown', () => {
    expect(senderHealthSummary({ total: 5, healthy: null }).healthy_rate).toBeNull()
  })

  it('flags a fleet where more mailboxes are healthy than exist', () => {
    const s = senderHealthSummary({ total: 2, healthy: 5 })
    expect(s.healthy_rate).toBe(2.5)
    expect(s.is_inconsistent).toBe(true)
  })

  it('does not flag a normal fleet', () => {
    expect(senderHealthSummary({ total: 5, healthy: 4 }).is_inconsistent).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Scale + path building — a missing point must break the line, not join it.
// ---------------------------------------------------------------------------
describe('buildScale', () => {
  it('maps values into the plot box', () => {
    const s = buildScale([0, 1], { width: 200, height: 100, padding: 0 })
    expect(s.y(0)).toBe(100)
    expect(s.y(1)).toBe(0)
  })

  it('collapses to a zero-height box when every value is identical', () => {
    const s = buildScale([5, 5, 5], { width: 200, height: 100, padding: 0 })
    expect(Number.isFinite(s.y(5))).toBe(true)
  })

  it('returns an unusable scale for no values, rather than NaN geometry', () => {
    const s = buildScale([], { width: 200, height: 100, padding: 0 })
    expect(Number.isFinite(s.y(0.5))).toBe(true)
  })
})

describe('contiguousSegments', () => {
  it('splits a run of known points into one segment', () => {
    const segs = contiguousSegments([0.1, 0.2, 0.3])
    expect(segs).toEqual([[0, 1, 2]])
  })

  it('breaks the line at a null so a gap is not drawn as a straight edge', () => {
    const segs = contiguousSegments([0.1, null, 0.3, 0.4])
    expect(segs).toEqual([[0], [2, 3]])
  })

  it('returns no segments when nothing is known', () => {
    expect(contiguousSegments([null, null])).toEqual([])
  })

  it('handles a leading and trailing gap', () => {
    expect(contiguousSegments([null, 0.2, null])).toEqual([[1]])
  })
})

describe('buildLinePath', () => {
  const box = { width: 100, height: 50, padding: 0 }

  it('produces an M/L path across contiguous points', () => {
    const path = buildLinePath([0, 1, 2], [0.1, 0.2, 0.3], box)
    expect(path).toMatch(/^M/)
    expect(path).toContain('L')
    expect(path).not.toContain('NaN')
  })

  it('joins only within a segment, never across a gap', () => {
    const path = buildLinePath([0, 1, 2, 3], [0.1, null, 0.3, 0.4], box)
    expect(path).not.toContain('NaN')
    // two M commands => two separate strokes
    expect((path.match(/M/g) || []).length).toBe(2)
  })

  it('returns an empty string when there is nothing to draw', () => {
    expect(buildLinePath([0, 1], [null, null], box)).toBe('')
  })
})
