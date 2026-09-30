/**
 * Chart math for the marketing dashboard.
 *
 * Rules that are enforced HERE, not in the components:
 *  - A rate is ALWAYS numerator / denominator from raw counts. A rate is never averaged.
 *  - `null` means "the API did not say". It never becomes 0, and a missing value never
 *    contributes to a total. This module contains no `?? 0`.
 *  - A rate above 1 is arithmetically impossible and is flagged, not rendered as fact.
 *  - Anything derived from an unknown input is itself unknown.
 */

export type Count = number | null | undefined

const isKnown = (n: Count): n is number => typeof n === 'number' && Number.isFinite(n)

/** Round to 4dp. 50/1000 -> 0.05; 1/3 -> 0.3333. Avoids float noise in the DOM. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/**
 * The only function permitted to produce a rate.
 *
 * Returns null — not 0, not Infinity, not NaN — when either input is unknown or the
 * denominator is not a positive count. A rate with a zero denominator is a
 * division that did not happen, and it has no honest numeric representation.
 */
export function safeRate(numerator: Count, denominator: Count): number | null {
  if (!isKnown(numerator)) return null
  if (!isKnown(denominator)) return null
  if (denominator <= 0) return null
  return round4(numerator / denominator)
}

/**
 * Reply rate from human replies only.
 *
 * `replies_human` is the autoresponder-free count. The contaminated figure that
 * produced 333% and 450% came from counting autoresponders as human replies, so
 * autoresponders are accepted here purely so callers must think about them, and are
 * never added into the numerator.
 */
export function humanReplyRate(
  emailsSent: Count,
  repliesHuman: Count,
  _repliesAutoresponder: Count,
): number | null {
  return safeRate(repliesHuman, emailsSent)
}

/**
 * A reply rate above 100% is a bug, never a real result. It can only arise from
 * autoresponders being counted as human replies. The figure is still returned so
 * the UI can show the raw counts with the suppression copy — but it is flagged.
 *
 * A null rate is NOT unreliable; it is missing. Those are different states.
 */
export function replyRateIsUnreliable(rate: number | null): boolean {
  return rate !== null && rate > 1
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/**
 * Sum a set of counts, but only if every one of them is known.
 *
 * Summing [1, null, 3] to 4 would be a number that looks measured and is actually
 * an undercount. A total built on an unknown part is itself unknown.
 * An empty list is also unknown: no rows is not a total of zero.
 */
export function sumKnown(values: Count[]): number | null {
  if (values.length === 0) return null
  let total = 0
  for (const v of values) {
    if (!isKnown(v)) return null
    total += v
  }
  return total
}

// ---------------------------------------------------------------------------
// Reply-rate trend
// ---------------------------------------------------------------------------

export interface TrendDayInput {
  metric_date: string
  emails_sent: Count
  replies_human: Count
  replies_autoresponder?: Count
}

export interface TrendPoint {
  metric_date: string
  emails_sent: number | null
  replies_human: number | null
  replies_autoresponder: number | null
  /** Human-reply rate for that single day, from that day's raw counts. */
  reply_rate: number | null
  /** Always null: the Instantly API cannot report open_rate. Never plotted, never faked. */
  open_rate: null
  /** True when this day's own rate is arithmetically impossible. */
  unreliable: boolean
}

export interface TrendPeriod {
  emails_sent: number
  replies_human: number
  replies_autoresponder: number | null
  reply_rate: number | null
  /** True when ANY day in the period is impossible, so the whole period is suspect. */
  unreliable: boolean
}

export interface ReplyTrend {
  points: TrendPoint[]
  /** Null when the period cannot be totalled honestly (no data, or an unknown day). */
  period: TrendPeriod | null
  isEmpty: boolean
}

export function buildReplyTrend(days: TrendDayInput[]): ReplyTrend {
  if (!days || days.length === 0) {
    return { points: [], period: null, isEmpty: true }
  }

  // Ascending by date, de-duplicated: a re-collected day must not be counted twice.
  const byDate = new Map<string, TrendDayInput>()
  for (const d of days) {
    if (d && typeof d.metric_date === 'string') byDate.set(d.metric_date, d)
  }
  const ordered = [...byDate.values()].sort((a, b) => (a.metric_date < b.metric_date ? -1 : 1))

  const points: TrendPoint[] = ordered.map((d) => {
    const sent = isKnown(d.emails_sent) ? d.emails_sent : null
    const human = isKnown(d.replies_human) ? d.replies_human : null
    const auto = isKnown(d.replies_autoresponder) ? d.replies_autoresponder : null
    const rate = humanReplyRate(sent, human, auto)
    return {
      metric_date: d.metric_date,
      emails_sent: sent,
      replies_human: human,
      replies_autoresponder: auto,
      reply_rate: rate,
      open_rate: null,
      unreliable: replyRateIsUnreliable(rate),
    }
  })

  // The period rate is recomputed from the SUMMED raw counts.
  // It is never the mean of the daily rates — that is the averaging error.
  const sentTotal = sumKnown(points.map((p) => p.emails_sent))
  const humanTotal = sumKnown(points.map((p) => p.replies_human))
  const autoTotal = sumKnown(points.map((p) => p.replies_autoresponder))

  let period: TrendPeriod | null = null
  if (sentTotal !== null && humanTotal !== null) {
    const rate = safeRate(humanTotal, sentTotal)
    period = {
      emails_sent: sentTotal,
      replies_human: humanTotal,
      replies_autoresponder: autoTotal,
      reply_rate: rate,
      // If any single day is impossible, the summed period is also not trustworthy,
      // even when the summed number happens to look plausible.
      unreliable: points.some((p) => p.unreliable) || replyRateIsUnreliable(rate),
    }
  }

  return { points, period, isEmpty: points.length === 0 }
}

// ---------------------------------------------------------------------------
// Opportunity value — its own dimension. Never presented as revenue.
// ---------------------------------------------------------------------------

export interface OpportunityValueInput {
  openValue: Count
  openCount: Count
  /** Total value of all opportunities ever created, if known. */
  totalValue?: Count
}

export interface OpportunityValue {
  open_value: number | null
  open_count: number | null
  value_per_opportunity: number | null
  closed_value: number | null
  /** Always false. Open pipeline value is not revenue. This flag exists so no
   *  component can quietly relabel it. */
  is_revenue: false
}

export function opportunityValueSummary(input: OpportunityValueInput): OpportunityValue {
  const openValue = isKnown(input.openValue) ? input.openValue : null
  const openCount = isKnown(input.openCount) ? input.openCount : null

  // Mean value per open opportunity, from the raw pair. null when either is unknown.
  let valuePer: number | null = null
  if (openValue !== null && openCount !== null && openCount > 0) {
    valuePer = Math.round((openValue / openCount) * 100) / 100
  }

  // Closed value needs BOTH figures. With only the open figure, the remainder is
  // unknown, not zero.
  let closedValue: number | null = null
  const totalValue = isKnown(input.totalValue) ? input.totalValue : null
  if (openValue !== null && totalValue !== null) closedValue = totalValue - openValue

  return {
    open_value: openValue,
    open_count: openCount,
    value_per_opportunity: valuePer,
    closed_value: closedValue,
    is_revenue: false,
  }
}

// ---------------------------------------------------------------------------
// Sender health — per sending mailbox, from raw counts.
// ---------------------------------------------------------------------------

export interface SenderHealthInput {
  total: Count
  healthy: Count
}

export interface SenderHealth {
  total: number | null
  healthy: number | null
  unhealthy: number | null
  healthy_rate: number | null
  /** True when the counts contradict each other — a data bug worth surfacing. */
  is_inconsistent: boolean
}

export function senderHealthSummary(input: SenderHealthInput): SenderHealth {
  const total = isKnown(input.total) ? input.total : null
  const healthy = isKnown(input.healthy) ? input.healthy : null

  // A fleet of zero mailboxes has no health rate. 0 mailboxes is not a 0% fleet.
  const healthyRate = safeRate(healthy, total)

  // "unhealthy" is only meaningful when both counts are known.
  const unhealthy = total !== null && healthy !== null ? total - healthy : null

  return {
    total,
    healthy,
    unhealthy,
    healthy_rate: healthyRate,
    is_inconsistent: healthy !== null && total !== null && healthy > total,
  }
}

// ---------------------------------------------------------------------------
// Geometry — pure functions, no DOM.
// ---------------------------------------------------------------------------

export interface PlotBox {
  width: number
  height: number
  padding: number
}

export interface Scale {
  y: (value: number) => number
  min: number
  max: number
}

/**
 * Map data values into pixel space within a plot box.
 *
 * Degenerate inputs (all values identical, or no values at all) must still produce
 * finite coordinates. A NaN in an SVG path attribute renders nothing at all and the
 * failure looks like an empty chart, which is the one thing an empty chart must
 * not be mistaken for.
 */
export function buildScale(values: number[], box: PlotBox): Scale {
  const innerW = Math.max(1, box.width - box.padding * 2)
  const innerH = Math.max(1, box.height - box.padding * 2)

  const known = values.filter((v) => typeof v === 'number' && Number.isFinite(v))

  if (known.length === 0) {
    // Nothing to scale. Park everything mid-height rather than emitting NaN.
    return { y: () => box.padding + innerH / 2, min: 0, max: 0 }
  }

  let min = Math.min(...known)
  let max = Math.max(...known)

  if (min === max) {
    // A flat series still needs a finite, sensible y. Give it a small symmetric band.
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1
    min -= pad
    max += pad
  }

  const span = max - min || 1
  return {
    min,
    max,
    y: (value: number) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return box.padding + innerH
      return box.padding + innerH - ((value - min) / span) * innerH
    },
  }
}

/**
 * Group indexes of known values into runs of contiguity.
 *
 * [0.1, null, 0.3, 0.4] -> [[0], [2, 3]]
 * A missing day must break the line. Joining across a gap draws a straight edge
 * that implies measurements on the days we do not have.
 */
export function contiguousSegments(values: (number | null)[]): number[][] {
  const segments: number[][] = []
  let current: number[] = []
  values.forEach((v, i) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      current.push(i)
    } else if (current.length > 0) {
      segments.push(current)
      current = []
    }
  })
  if (current.length > 0) segments.push(current)
  return segments
}

/** Build an SVG path that never crosses a gap and never emits NaN. */
export function buildLinePath(
  xs: number[],
  ys: (number | null)[],
  box: PlotBox,
): string {
  const usable = xs
    .map((x, i) => ({ x, y: ys[i] }))
    .filter((p): p is { x: number; y: number } =>
      typeof p.y === 'number' && Number.isFinite(p.y))

  if (usable.length === 0) return ''

  // Contiguity is evaluated on the ORIGINAL index space, not the filtered one, so a
  // gap between two known points still splits the stroke.
  const segments: number[][] = []
  let current: number[] = []
  ys.forEach((y, i) => {
    if (typeof y === 'number' && Number.isFinite(y)) current.push(i)
    else if (current.length > 0) { segments.push(current); current = [] }
  })
  if (current.length > 0) segments.push(current)

  const innerW = Math.max(1, box.width - box.padding * 2)
  const denom = Math.max(1, xs.length - 1)

  return segments
    .map((seg) => {
      const d = seg
        .map((idx, j) => {
          const x = box.padding + (xs[idx] / denom) * innerW
          const y = ys[idx] as number
          const px = Math.round(x * 100) / 100
          const py = Math.round(y * 100) / 100
          return j === 0 ? `M${px},${py}` : `L${px},${py}`
        })
        .join(' ')
      return d
    })
    .join(' ')
}
