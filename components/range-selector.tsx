import Link from 'next/link'
import { COPY } from '@/lib/copy'
import { RANGE_LABEL, SUPPORTED_RANGE_KEYS, Range } from '@/lib/range'

/**
 * The reporting-window switcher.
 *
 * The options are `SUPPORTED_RANGES` from lib/range.ts rather than a
 * second copy of the same three strings, so a window added to the
 * constant appears here on the same change that teaches the API about
 * it. A literal here is exactly the drift the constant exists to
 * prevent.
 *
 * Each link keeps the query params it does not own -- the dashboard's
 * filter and table state -- and replaces only `range`.
 */
export function RangeSelector({
  currentRange,
  searchParams,
}: {
  currentRange: string
  searchParams?: URLSearchParams
}) {
  return (
    <div
      role="group"
      aria-label={COPY.rangeSelector}
      className="flex gap-2 text-xs bg-surface border border-line rounded p-1"
    >
      {SUPPORTED_RANGE_KEYS.map((range) => {
        const isActive = currentRange === range
        const next = new URLSearchParams(searchParams?.toString() ?? '')
        next.set('range', range)
        return (
          <Link
            key={range}
            href={`/?${next.toString()}`}
            aria-current={isActive ? 'true' : undefined}
            className={`px-3 py-1 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-muted ${
              isActive
                ? 'bg-ink text-white font-medium'
                : 'text-ink-muted hover:text-ink hover:bg-line-soft'
            }`}
          >
            {range === '7d' ? RANGE_LABEL : `Last ${range.slice(0, -1)} days`}
          </Link>
        )
      })}
    </div>
  )
}
