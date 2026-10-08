import Link from 'next/link'
import type { BoardTask } from '@/lib/ops/queries'
import { Ago, kindLabel } from './bits'

function progressLine(p: unknown): string | null {
  if (!p || typeof p !== 'object') return null
  const o = p as Record<string, unknown>
  if (typeof o.summary === 'string') return o.summary
  if (typeof o.done === 'number' && typeof o.of === 'number') return `${o.done} of ${o.of}`
  if (typeof o.done === 'number' && typeof o.total === 'number') return `${o.done} of ${o.total}`
  return null
}

export function TaskCard({ t, now }: { t: BoardTask; now: Date }) {
  const prog = progressLine(t.progress)
  const leaseLeft = t.lease_expires_at ? new Date(t.lease_expires_at).getTime() - now.getTime() : null
  const stale = t.claimed_by && leaseLeft !== null && leaseLeft < 0 && ['claimed', 'running'].includes(t.status)
  return (
    <Link
      href={`/team/${t.id}`}
      className="block rounded-card border border-line bg-surface px-3 py-2.5 shadow-card transition-colors hover:border-ink-faint"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-[13px] font-medium leading-snug text-ink">{t.title}</p>
        {t.priority > 0 ? <span className="shrink-0 text-[11px] tabular-nums text-warn">P{t.priority}</span> : null}
      </div>
      <p className="mt-1 text-[11.5px] leading-snug text-ink-faint">
        {kindLabel(t.kind)}
        {t.project_name ? ` · ${t.project_name}` : ''}
        {t.company_name ? ` · ${t.company_name}` : ''}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-muted">
        <span>
          {t.claimed_by ? (
            <>
              <span className="text-ink">{t.claimed_name}</span> on it
            </>
          ) : t.assigned_to ? (
            <>
              for <span className="text-ink">{t.assigned_name}</span>
            </>
          ) : (
            'anyone can pick it up'
          )}
        </span>
        {prog ? <span className="tabular-nums">{prog}</span> : null}
        {stale ? <span className="text-warn">went quiet</span> : null}
        {t.comments ? <span className="tabular-nums">{t.comments} {t.comments === 1 ? 'note' : 'notes'}</span> : null}
        <span className="ml-auto text-ink-faint">
          <Ago at={t.updated_at} now={now} />
        </span>
      </div>
    </Link>
  )
}
