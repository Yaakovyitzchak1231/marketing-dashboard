import { formatCount, formatRate, formatCurrency, isUnavailable } from '@/lib/format'
import { Card, Unavailable, Figure } from '@/components/primitives'

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
 * per-campaign treatment.
 */
function isImplausibleRate(value: number | null, kind: Kpi['kind']): boolean {
  return kind === 'rate' && !isUnavailable(value) && value > 1
}

export function KpiCell({ kpi }: { kpi: Kpi }) {
  const unavailable = isUnavailable(kpi.value) || isImplausibleRate(kpi.value, kpi.kind)

  return (
    <div
      data-testid={`kpi-${kpi.key}`}
      data-unavailable={unavailable ? 'true' : 'false'}
      className="min-w-0 flex-1 px-4 py-3 first:pl-5 last:pr-5"
    >
      <div className="truncate text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted">
        {kpi.label}
      </div>
      <div className="mt-1 text-metric-sm font-medium text-ink">
        {unavailable ? <Unavailable /> : <Figure>{FORMATTERS[kpi.kind](kpi.value as number)}</Figure>}
      </div>
      {kpi.note ? (
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
  return (
    <Card className="overflow-hidden">
      <div
        data-testid="kpi-row"
        className="grid grid-cols-2 divide-line xs:divide-x sm:grid-cols-3 sm:divide-y-0 lg:flex lg:flex-row"
      >
        {kpis.map((kpi) => (
          <div
            key={kpi.key}
            className="border-b border-line-soft last:border-b-0 sm:border-b-0"
          >
            <KpiCell kpi={kpi} />
          </div>
        ))}
      </div>
    </Card>
  )
}
