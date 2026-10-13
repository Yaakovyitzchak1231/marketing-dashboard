import Link from 'next/link'
import { Card, Pill, Val, type PillTone } from '@/components/dashboard/primitives'
import { Ago } from '@/components/ops/bits'
import type { Integration, LatestMetric } from '@/lib/integrations/store'

const HEALTH_TONE: Record<string, PillTone> = { ok: 'good', degraded: 'warn', down: 'bad', unknown: 'neutral' }
const HEALTH_WORD: Record<string, string> = { ok: 'Healthy', degraded: 'Degraded', down: 'Down', unknown: 'Unknown' }

/** "listmonk.subscribers" -> "Subscribers". The tool name prefix is already on the card. */
function metricLabel(metric: string): string {
  const last = metric.split('.').pop() ?? metric
  return last.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function dimsLabel(dims: Record<string, unknown>): string | null {
  const vals = Object.values(dims).filter((v) => v != null && v !== '')
  if (!vals.length) return null
  return vals.map(String).join(' · ')
}

export function HealthRow({ integration, now }: { integration: Integration; now: Date }) {
  if (!integration.health_checked_at) {
    return <p className="text-xs text-ink-faint">Not checked yet — runner not deployed</p>
  }
  const tone = HEALTH_TONE[integration.health_status ?? 'unknown'] ?? 'neutral'
  const word = HEALTH_WORD[integration.health_status ?? 'unknown'] ?? 'Unknown'
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
      <Pill tone={tone} title={integration.health_detail ?? undefined}>{word}</Pill>
      <span>
        checked <Ago at={integration.health_checked_at} now={now} />
      </span>
    </p>
  )
}

export function MetricRow({ metric }: { metric: LatestMetric }) {
  const dims = dimsLabel(metric.dims)
  return (
    <li className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="min-w-0 truncate text-ink-muted">
        {metricLabel(metric.metric)}
        {dims ? <span className="text-ink-faint"> · {dims}</span> : null}
      </span>
      <span className="shrink-0 font-numeric tabular-nums text-ink">
        <Val value={metric.value}>{metric.value}</Val>
      </span>
    </li>
  )
}

export function ToolCard({
  integration,
  metrics,
  now,
}: {
  integration: Integration
  metrics: LatestMetric[]
  now: Date
}) {
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">{integration.name}</h3>
          {integration.url ? (
            <Link
              href={integration.url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-xs font-medium text-accent hover:underline"
            >
              Open
            </Link>
          ) : null}
        </div>
        {integration.description ? <p className="mt-0.5 text-xs leading-snug text-ink-faint">{integration.description}</p> : null}
        {integration.reachable_from === 'tailnet' ? (
          <p className="mt-1 text-2xs text-ink-faint">Tailnet only — opens only on your Tailscale devices</p>
        ) : null}
      </div>
      <HealthRow integration={integration} now={now} />
      {metrics.length ? (
        <ul className="divide-y divide-line border-t border-line pt-1">
          {metrics.map((m, i) => (
            <MetricRow key={`${m.metric}-${m.campaign_id ?? 'global'}-${i}`} metric={m} />
          ))}
        </ul>
      ) : null}
    </Card>
  )
}

export function LinkCard({ integration }: { integration: Integration }) {
  return (
    <Card className="flex flex-col gap-1.5 p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{integration.name}</h3>
        {integration.url ? (
          <Link href={integration.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs font-medium text-accent hover:underline">
            Open
          </Link>
        ) : null}
      </div>
      {integration.description ? <p className="text-xs leading-snug text-ink-faint">{integration.description}</p> : null}
    </Card>
  )
}
