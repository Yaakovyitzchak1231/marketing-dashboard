'use client'

import { useState } from 'react'
import { formatCount, isUnavailable } from '@/lib/format'
import { CHART_GEOMETRY, chartViewBox, scaleX, scaleY } from '@/lib/chart'
import { Card, SectionLabel, Figure, Unavailable } from '@/components/primitives'
import { COPY } from '@/lib/copy'

/**
 * The trend chart area.
 *
 * DESIGN NOTE: drawn as inline SVG by hand rather than with a charting
 * library. A library brings a theme, a default palette, a legend and a tooltip
 * chrome we do not want. The whole visual vocabulary here is one accent stroke
 * and one hairline baseline.
 *
 * HONESTY NOTE: all the states are first-class.
 *   - 0 rows          -> "Collecting history" (bug 4: history is a single day,
 *                        and on a fresh install it is none, so this is the
 *                        state the dashboard will actually sit in for a while)
 *   - rows, no values -> "Not reported by Instantly"
 *   - 1 point         -> labelled as a single day, because a lone point is not
 *                        a trend and drawing a line through it would invent a
 *                        slope the data does not contain
 *   - 2+ points       -> a real line
 */

/**
 * One stored day.
 *
 * Three metrics the source records per day, none of them derived here. The
 * card plots one at a time, so every field is `number | null` and switching
 * metrics re-reads the SAME rows rather than refetching or recomputing.
 */
export type TrendPoint = {
  day: string
  emails_sent: number | null
  replies_human: number | null
  opportunities: number | null
}

/** The metrics the card can plot. Each is a stored per-day count, not a rate. */
type TrendMetric = 'emails_sent' | 'replies_human' | 'opportunities'

const TREND_METRIC_LABELS: Record<TrendMetric, string> = {
  emails_sent: COPY.trend.emailsSent,
  replies_human: COPY.trend.uniqueReplies,
  opportunities: COPY.trend.opportunities,
}

const TREND_METRICS: { key: TrendMetric; label: string }[] = (
  Object.keys(TREND_METRIC_LABELS) as TrendMetric[]
).map((key) => ({ key, label: TREND_METRIC_LABELS[key] }))

function isTrendMetric(value: string): value is TrendMetric {
  return TREND_METRICS.some((metric) => metric.key === value)
}

/** A point reduced to the one metric being plotted. */
type Plotted = { day: string; value: number }

/**
 * Days the source did not report are dropped from the line rather than
 * interpolated to zero. A gap in reporting is a gap, not a dip.
 */
function plottable(series: TrendPoint[], metric: TrendMetric): Plotted[] {
  const out: Plotted[] = []
  for (const point of series) {
    const value = point[metric]
    if (!isUnavailable(value) && Number.isFinite(value)) out.push({ day: point.day, value })
  }
  return out
}

function TrendSvg({ points, isFlat }: { points: Plotted[]; isFlat: boolean }) {
  const { width, height, padX, padY, strokeWidth, pointRadius, axisStrokeWidth } =
    CHART_GEOMETRY
  const values = points.map((p) => p.value as number)
  const min = Math.min(...values)
  const max = Math.max(...values)

  const coords = points.map((p, i) => ({
    x: scaleX(i, points.length),
    y: scaleY(p.value as number, min, max),
  }))

  const path = coords
    .map((c, i) => `${i === CHART_GEOMETRY.zero ? 'M' : 'L'}${c.x.toFixed(2)} ${c.y.toFixed(2)}`)
    .join(' ')
  const firstValue = values[CHART_GEOMETRY.zero]
  const lastValue = values[values.length - 1]
  const change = lastValue - firstValue

  // A flat series has no interior gridline to draw: max, min and their midpoint
  // are the same number, so three gridlines stack on one y and the chart shows
  // a dashed line drawn over itself. One baseline is the whole truth of a flat
  // series, so one baseline is what gets drawn.
  const gridY = isFlat
    ? [scaleY(min, min, max)]
    : [scaleY(max, min, max), scaleY(min + (max - min) / (CHART_GEOMETRY.gridLineCount - 1), min, max), scaleY(min, min, max)]

  return (
    <div className="relative">
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-between text-[10px] text-ink-faint" aria-hidden="true">
        {isFlat ? (
          // Repeating the same figure twice on either side of the plot is what
          // made this read as broken. One label, positioned, says the same thing.
          <span>{formatCount(max)}</span>
        ) : (
          <>
            <span>{formatCount(max)}</span>
            <span>{formatCount(min)}</span>
          </>
        )}
      </div>
      <svg
      viewBox={chartViewBox()}
      preserveAspectRatio="none"
      className="h-32 w-full sm:h-40"
      role="img"
      aria-label={
        isFlat
          ? `${points.length} days, all reporting the same running total of ${formatCount(max)}`
          : `${points.length} days of data, from ${formatCount(firstValue)} to ${formatCount(lastValue)}, changing by ${change >= CHART_GEOMETRY.zero ? '+' : ''}${formatCount(change)}`
      }
    >
      {gridY.map((y, index) => (
        <line
          key={index}
          x1={padX}
          y1={y}
          x2={width - padX}
          y2={y}
          stroke="currentColor"
          strokeWidth={index === gridY.length - CHART_GEOMETRY.zero - 1 ? axisStrokeWidth : CHART_GEOMETRY.gridStrokeWidth}
          className={index === gridY.length - 1 ? 'text-line' : 'text-line-soft'}
          strokeDasharray={index === gridY.length - CHART_GEOMETRY.zero - 1 ? undefined : CHART_GEOMETRY.gridDash}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {points.length > 1 ? (
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
          className="text-accent"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {coords.length === 1 ? (
        <circle
          cx={coords[0].x}
          cy={coords[0].y}
          r={pointRadius}
          className="fill-accent"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {/* One marker per day, so the reader can count real observations rather
          than infer them from the shape of a stroke. */}
      {coords.map((c, i) => (
        <circle
          key={i}
          cx={c.x}
          cy={c.y}
          r={pointRadius}
          className="fill-accent"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
    </div>
  )
}

/**
 * The stored figures, day by day.
 *
 * A line is the wrong shape for three points and actively misleading for a
 * running total, so the numbers a reader actually needs are printed. This
 * deliberately receives EVERY day the source reported a date for -- not the
 * null-filtered series -- because a day with no value is information: it
 * appears as a dash, which says "the collector ran and Instantly reported
 * nothing", rather than silently vanishing.
 */
function DailyBreakdown({ days, metric }: { days: TrendPoint[]; metric: TrendMetric }) {
  if (days.length === CHART_GEOMETRY.zero) return null
  const columnLabel = TREND_METRICS.find((m) => m.key === metric)?.label ?? metric
  return (
    <div data-testid="trend-breakdown" className="mt-3 border-t border-line-soft pt-3">
      <SectionLabel>{COPY.trendBreakdownTitle}</SectionLabel>
      <div data-tabular="true" className="mt-1">
        <div className="flex justify-between gap-4 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted">
          <span>{COPY.trendBreakdownDay}</span>
          <span className="text-right">{columnLabel}</span>
        </div>
        {days.map((p) => {
          const value = p[metric]
          return (
            <div
              key={p.day}
              className="flex justify-between gap-4 border-b border-line-soft py-1 text-[12px] last:border-b-0"
            >
              <span className="text-ink-faint">{p.day}</span>
              <span className="text-ink">
                {isUnavailable(value) ? <Unavailable /> : <Figure>{formatCount(value)}</Figure>}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function TrendChartArea({ series, label }: { series: TrendPoint[]; label?: string }) {
  // Metric choice is local view state, not a data-loading decision: all three
  // series arrive in the same rows, so switching re-reads what is already here
  // and never refetches. `emails_sent` is the default because that is the
  // series the card was built around.
  const [metric, setMetric] = useState<TrendMetric>('emails_sent')
  const points = plottable(series, metric)
  const first = points[0]
  const last = points[points.length - 1]
  const values = points.map((point) => point.value)
  const min = values.length > 0 ? Math.min(...values) : CHART_GEOMETRY.zero
  const max = values.length > 0 ? Math.max(...values) : CHART_GEOMETRY.zero
  const change = last && first ? last.value - first.value : CHART_GEOMETRY.zero
  // Every day reporting the same figure is a property of the source -- a
  // campaign-to-date total that has stopped moving -- and not an absence of
  // data. The two are worth different words on screen. `>=`, not `>`: three
  // identical days is the smallest series that can say this at all, and it is
  // exactly the series the account actually has.
  const isFlat = points.length >= CHART_GEOMETRY.minimumFlatPoints && min === max
  // The table shows every dated day, including ones the line drops for having
  // no value -- a missing day is a reported gap, and hiding it would be the
  // same sin as zero-filling it.
  const datedDays = series.filter((p) => !isUnavailable(p.day))
  // The running-total state belongs to the metric that is actually flat, so the
  // label names that metric rather than always saying "emails sent". A reader
  // who switched to replies must not be told the line totals emails.
  const sectionLabel = isFlat
    ? COPY.trend.cumulativeLabel[metric]
    : (label ?? TREND_METRIC_LABELS[metric])

  return (
    <Card testId="trend-chart" className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2">
          <SectionLabel>{sectionLabel}</SectionLabel>
          <select
            aria-label={COPY.trend.metricLabel}
            value={metric}
            onChange={(e) => {
              const next = e.target.value
              if (isTrendMetric(next)) setMetric(next)
            }}
            className="h-6 rounded border border-line bg-surface px-1 text-[11px] text-ink-muted outline-none focus:text-ink focus-visible:ring-2 focus-visible:ring-ink-muted"
          >
            {TREND_METRICS.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </div>
        {points.length > 1 && !isFlat ? (
          <span className="text-[11px] text-ink-faint">
            <Figure>{formatCount(last.value)}</Figure>{' '}
            {change >= CHART_GEOMETRY.zero ? '+' : ''}{formatCount(change)} vs first day
          </span>
        ) : null}
        {/* A count of days is data about the data, not a metric. It is the one
            number here that explains the shape of the chart -- without it a
            nearly-flat line looks like a rendering bug. */}
        <span data-testid="trend-point-count" className="text-[11px] text-ink-faint">
          <Figure>{formatCount(points.length)}</Figure>
          {points.length === 1 ? ' day' : ' days'}
        </span>
      </div>

      {series.length === 0 ? (
        // Bug 4. A working system with nothing to draw yet. This must read as
        // a first-run state, not a broken chart -- so it is a labelled band the
        // same height as the chart, not a collapsed gap.
        <div
          data-testid="trend-empty"
          className="mt-3 flex h-32 items-center justify-center border-t border-line-soft text-[13px] text-ink-faint sm:h-40"
        >
          {COPY.trendEmpty}
        </div>
      ) : points.length === 0 ? (
        // Rows exist but none carry a value. Distinct from "no rows": the
        // collector ran and the metrics were not reported.
        <div
          data-testid="trend-empty"
          className="mt-3 flex h-32 items-center justify-center border-t border-line-soft text-[13px] text-ink-faint sm:h-40"
        >
          {COPY.metricUnavailable}
        </div>
      ) : points.length === 1 ? (
        // A single day is a fact, not a trend. Drawing a line here would
        // invent a slope.
        <div className="mt-3 border-t border-line-soft pt-3">
          <TrendSvg points={points} isFlat={isFlat} />
          <div data-testid="trend-single" className="mt-1 text-[11px] text-ink-faint">
            One day collected &mdash; a trend needs at least two.
          </div>
        </div>
      ) : (
        <div className="mt-3 border-t border-line-soft pt-3">
          <TrendSvg points={points} isFlat={isFlat} />
          {isFlat ? (
            // The flat line is real data, not a rendering fault, so it is
            // explained rather than apologised for. Without this sentence a
            // reader has no way to tell a quiet account from a cumulative
            // counter that has stopped moving.
            <p data-testid="trend-cumulative-note" className="mt-1 text-[11px] text-ink-faint">
              {COPY.trendCumulativeNote}
            </p>
          ) : null}
          <div className="mt-1 flex justify-between text-[11px] text-ink-faint">
            <span>{first.day}</span>
            <span>{last.day}</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-ink-faint">
            <span>Observed range: {formatCount(min)}&ndash;{formatCount(max)}</span>
            <span>
              Latest: {isUnavailable(last.value) ? <Unavailable /> : <Figure>{formatCount(last.value)}</Figure>}
            </span>
          </div>
          <DailyBreakdown days={datedDays} metric={metric} />
        </div>
      )}
    </Card>
  )
}
