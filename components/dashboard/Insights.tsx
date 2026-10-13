import type { Insight, InsightSeverity } from '@/lib/dashboard/types'
import { Card, EmptyNote, SectionHeader } from './primitives'

const SEVERITY: Record<InsightSeverity, { label: string; bar: string; text: string; rank: number }> = {
  critical: { label: 'Fix now', bar: 'bg-bad', text: 'text-bad', rank: 0 },
  warning: { label: 'Watch', bar: 'bg-warn', text: 'text-warn', rank: 1 },
  opportunity: { label: 'Opportunity', bar: 'bg-accent', text: 'text-accent', rank: 2 },
  win: { label: 'Working', bar: 'bg-good', text: 'text-good', rank: 3 },
}

const VISIBLE = 4

function InsightItem({ insight }: { insight: Insight }) {
  const s = SEVERITY[insight.severity] ?? SEVERITY.opportunity
  return (
    <li className="relative flex gap-4 px-4 py-4 sm:px-5" data-severity={insight.severity}>
      <span aria-hidden className={`absolute left-0 top-4 bottom-4 w-[3px] rounded-r ${s.bar}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={`text-2xs font-semibold uppercase tracking-[0.06em] ${s.text}`}>{s.label}</span>
          {insight.entity ? (
            <span className="truncate text-xs text-ink-faint">{insight.entity.name}</span>
          ) : null}
        </div>
        <p className="mt-1 text-base font-semibold leading-snug text-ink">{insight.title}</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-muted">{insight.detail}</p>
        <p className="mt-2 text-sm leading-relaxed text-ink">
          <span className="font-semibold">Next: </span>
          {insight.action}
        </p>
      </div>
      {insight.metric ? (
        <div className="hidden shrink-0 text-right sm:block">
          <div className="font-numeric text-metric-sm text-ink">{insight.metric.value}</div>
          <div className="mt-0.5 max-w-[140px] text-2xs leading-tight text-ink-faint">{insight.metric.label}</div>
        </div>
      ) : null}
    </li>
  )
}

export function Insights({ insights }: { insights: Insight[] }) {
  // Stable sort by severity; the engine's order is kept within a severity.
  const sorted = insights
    .map((i, idx) => ({ i, idx }))
    .sort((a, b) => (SEVERITY[a.i.severity]?.rank ?? 9) - (SEVERITY[b.i.severity]?.rank ?? 9) || a.idx - b.idx)
    .map((x) => x.i)
  const head = sorted.slice(0, VISIBLE)
  const rest = sorted.slice(VISIBLE)
  const urgent = insights.filter((i) => i.severity === 'critical' || i.severity === 'warning').length

  return (
    <section aria-labelledby="next-heading">
      <SectionHeader
        id="next-heading"
        title="What to do next"
        meta={insights.length ? `${insights.length} callout${insights.length === 1 ? '' : 's'}${urgent ? ` · ${urgent} need attention` : ''}` : undefined}
      />
      <Card>
        {sorted.length === 0 ? (
          <EmptyNote>Nothing stands out in this range. No problems or clear winners in the numbers yet.</EmptyNote>
        ) : (
          <>
            <ul className="divide-y divide-line-soft" data-testid="insights">
              {head.map((i) => (
                <InsightItem key={i.id} insight={i} />
              ))}
            </ul>
            {rest.length ? (
              <details className="group border-t border-line-soft">
                <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-accent hover:underline sm:px-5">
                  <span className="group-open:hidden">Show {rest.length} more</span>
                  <span className="hidden group-open:inline">Show fewer</span>
                </summary>
                <ul className="divide-y divide-line-soft border-t border-line-soft">
                  {rest.map((i) => (
                    <InsightItem key={i.id} insight={i} />
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </Card>
    </section>
  )
}
