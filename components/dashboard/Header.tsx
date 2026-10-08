import Link from 'next/link'
import type { DateRange, RangeKey } from '@/lib/dashboard/types'
import { formatUpdated, rangeSpan } from './format'

export const RANGE_KEYS: RangeKey[] = ['7d', '14d', '30d', '90d', 'all']
const RANGE_SHORT: Record<RangeKey, string> = { '7d': '7d', '14d': '14d', '30d': '30d', '90d': '90d', all: 'All' }

export function Header({
  range,
  generatedAt,
  live,
}: {
  range: DateRange
  generatedAt: string | null
  /** false when not configured: no freshness line, nothing was fetched. */
  live: boolean
}) {
  const active = range.key
  return (
    <header className="border-b border-line bg-canvas/95 backdrop-blur supports-[backdrop-filter]:bg-canvas/80 sm:sticky sm:top-0 sm:z-20">
      <div className="mx-auto flex max-w-shell flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Cold email</h1>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-faint sm:truncate" data-testid="freshness">
            {live && generatedAt ? (
              <>
                {rangeSpan(range.start, range.end)} · Updated {formatUpdated(generatedAt, range.timezone)} · live from Instantly
              </>
            ) : (
              'Not connected to Instantly yet'
            )}
          </p>
        </div>
        {live ? (
        <div className="flex items-center gap-2">
          <nav aria-label="Date range" className="flex rounded-card border border-line bg-surface p-0.5">
            {RANGE_KEYS.map((k) => {
              const selected = k === active
              return (
                <Link
                  key={k}
                  href={`/?range=${k}`}
                  aria-current={selected ? 'page' : undefined}
                  prefetch={false}
                  className={`min-w-[40px] rounded-[3px] px-2.5 py-1.5 text-center text-[12px] font-medium tabular-nums transition-colors ${
                    selected ? 'bg-accent text-white' : 'text-ink-muted hover:bg-canvas hover:text-ink'
                  }`}
                >
                  {RANGE_SHORT[k]}
                </Link>
              )
            })}
          </nav>
          <a
            href={`/?range=${active === 'custom' ? '30d' : active}`}
            className="rounded-card border border-line bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink"
            title="Reload from Instantly (data is cached for up to 5 minutes)"
          >
            Refresh
          </a>
        </div>
        ) : null}
      </div>
    </header>
  )
}
