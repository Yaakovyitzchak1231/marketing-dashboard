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

/** One stored day. `value` is the raw count from the API, never derived here. */
export type TrendPoint = {
  day: string
  value: number | null
}

/**
 * Days the source did not report are dropped from the line rather than
 * interpolated to zero. A gap in reporting is a gap, not a dip.
 */
function plottable(series: TrendPoint[]): TrendPoint[] {
  return series.filter((p) => !isUnavailable(p.value) && Number.isFinite(p.value))
}

function TrendSvg({ points }: { points: TrendPoint[] }) {
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
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(2)} ${c.y.toFixed(2)}`)
    .join(' ')
  const firstValue = values[0]
  const lastValue = values[values.length - 1]
  const change = lastValue - firstValue
  const range = max - min
  const gridValues = [max, min + range / 2, min]
  const gridY = gridValues.map((value) => scaleY(value, min, max))

  return (
    <div className="relative">
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-between text-[10px] text-ink-faint" aria-hidden="true">
        <span>{formatCount(max)}</span>
        <span>{formatCount(min)}</span>
      </div>
      <svg
      viewBox={chartViewBox()}
      preserveAspectRatio="none"
      className="h-32 w-full sm:h-40"
      role="img"
      aria-label={`${points.length} days of data, from ${formatCount(firstValue)} to ${formatCount(lastValue)}, changing by ${change >= 0 ? '+' : ''}${formatCount(change)}`}
    >
      {gridY.map((y, index) => (
        <line
          key={index}
          x1={padX}
          y1={y}
          x2={width - padX}
          y2={y}
          stroke="currentColor"
          strokeWidth={index === gridY.length - 1 ? axisStrokeWidth : 0.75}
          className={index === gridY.length - 1 ? 'text-line' : 'text-line-soft'}
          strokeDasharray={index === gridY.length - 1 ? undefined : '2 4'}
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
    </svg>
  )
}

export function TrendChartArea({ series, label }: { series: TrendPoint[]; label: string }) {
  const points = plottable(series)
  const first = points[0]
  const last = points[points.length - 1]

  return (
    <Card testId="trend-chart" className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <SectionLabel>{label}</SectionLabel>
        {points.length > 1 ? (
          <span className="text-[11px] text-ink-faint">
            <Figure>{formatCount(last.value)}</Figure>{' '}
            {change >= 0 ? '+' : ''}{formatCount(change)} vs first day
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
          <TrendSvg points={points} />
          <div data-testid="trend-single" className="mt-1 text-[11px] text-ink-faint">
            One day collected &mdash; a trend needs at least two.
          </div>
        </div>
      ) : (
        <div className="mt-3 border-t border-line-soft pt-3">
          <TrendSvg points={points} />
          <div className="mt-1 flex justify-between text-[11px] text-ink-faint">
            <span>{first.day}</span>
            <span>{last.day}</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-ink-faint">
            <span>Observed range: {formatCount(min)}–{formatCount(max)}</span>
            <span>
              Latest: {isUnavailable(last.value) ? <Unavailable /> : <Figure>{formatCount(last.value)}</Figure>}
            </span>
          </div>
        </div>
      )}
    </Card>
  )
}
