'use client'

import { useState } from 'react'
import { formatCount, formatRate, formatCurrency, rateIsPlausible, isUnavailable } from '@/lib/format'
import { Card, Unavailable, Figure } from '@/components/primitives'
import { COPY } from '@/lib/copy'

/**
 * A single headline metric.
 *
 * `value` is `number | null` on purpose. There is no "default to zero" path
 * anywhere in this component: a metric the API did not report renders as a
 * dash, because the Instantly API does not populate open rate and rendering
 * that as 0.0% is the exact bug this dashboard was built to fix.
 */
export type Kpi = {
  key: string
  label: string
  value: number | null
  kind: 'count' | 'rate' | 'currency'
  /** Optional short note rendered under the value. Copy owns the words. */
  note?: string
}

const FORMATTERS = {
  count: formatCount,
  rate: formatRate,
  currency: formatCurrency,
} as const

/**
 * A rate above 100% cannot be real -- at best it means the denominator is
 * wrong. We never present it as a measurement; see `campaign-table` for the
 * per-campaign treatment. The ceiling itself is `MAX_PLAUSIBLE_RATE` in
 * lib/format so a reviewer has one place to argue with it.
 */
function isImplausibleRate(value: number | null, kind: Kpi['kind']): boolean {
  return kind === 'rate' && !isUnavailable(value) && !rateIsPlausible(value)
}

export function KpiCell({ kpi }: { kpi: Kpi }) {
  // Two different absences, deliberately kept apart:
  //   - the source did not report the metric -> dash + "not reported"
  //   - the source reported something impossible -> "not reliable"
  // Merging them (as an earlier draft did) is what made this dashboard read
  // 0.0% for a metric the API never populates.
  const unreported = isUnavailable(kpi.value)
  const unreliable = !unreported && isImplausibleRate(kpi.value, kpi.kind)

  return (
    <div
      data-testid={`kpi-${kpi.key}`}
      data-unavailable={unreported ? 'true' : 'false'}
      data-unreliable={unreliable ? 'true' : 'false'}
      className="min-w-0 flex-1 px-4 py-3 first:pl-5 last:pr-5"
    >
      <div className="truncate text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted">
        {kpi.label}
      </div>
      <div className="mt-1 text-metric-sm font-medium text-ink">
        {unreported ? (
          <Unavailable />
        ) : unreliable ? (
          <span className="text-warn">Not reliable</span>
        ) : (
          <Figure>{FORMATTERS[kpi.kind](kpi.value as number)}</Figure>
        )}
      </div>
      {/* The reason is spelled out, not left in a tooltip. A reader must be
          able to tell an absence from a bad number without hovering -- and
          nobody taps a tooltip on a phone. */}
      {unreliable ? (
        <div className="mt-0.5 truncate text-[11px] text-ink-faint">
          Autoresponders included
        </div>
      ) : unreported ? (
        <div className="mt-0.5 truncate text-[11px] text-ink-faint">
          {COPY.metricUnavailable}
        </div>
      ) : kpi.note ? (
        <div className="mt-0.5 truncate text-[11px] text-ink-faint">{kpi.note}</div>
      ) : null}
    </div>
  )
}

/**
 * The KPI row.
 *
 * RESPONSIVE IS A REQUIREMENT (task AC1): at 390px a five-across grid wraps to
 * two columns, not a clipped row or a horizontal scroll. Below `sm` it is a
 * 2-column grid; from `sm` up it is a single row of flexible cells separated by
 * vertical hairlines.
 */
export function KpiRow({ kpis }: { kpis: Kpi[] }) {
  const [visibleKeys, setVisibleKeys] = useState(() => new Set(kpis.map((kpi) => kpi.key)))
  const visibleKpis = kpis.filter((kpi) => visibleKeys.has(kpi.key))
  const toggleMetric = (key: string) => {
    setVisibleKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        if (next.size === 1) return next
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted">Metrics</span>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter metrics">
          {kpis.map((kpi) => {
            const active = visibleKeys.has(kpi.key)
            return (
              <button
                key={kpi.key}
                type="button"
                aria-pressed={active}
                onClick={() => toggleMetric(kpi.key)}
                className={`rounded border px-2 py-1 text-[11px] ${active ? 'border-ink-muted text-ink' : 'border-line text-ink-faint'}`}
              >
                {kpi.label}
              </button>
            )
          })}
        </div>
      </div>
      <div
        data-testid="kpi-row"
        className="grid grid-cols-2 divide-line xs:divide-x sm:grid-cols-3 sm:divide-y-0 lg:flex lg:flex-row"
      >
        {visibleKpis.map((kpi) => (
          <div key={kpi.key} className="border-b border-line-soft last:border-b-0 sm:border-b-0">
            <KpiCell kpi={kpi} />
          </div>
        ))}
      </div>
    </Card>
  )
}
