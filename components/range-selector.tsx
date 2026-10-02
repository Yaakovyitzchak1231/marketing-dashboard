import Link from 'next/link'
import { Range } from '@/lib/range'

export function RangeSelector({ currentRange }: { currentRange: Range }) {
  return (
    <div className="flex gap-2 text-[12px] bg-surface border border-line rounded p-1">
      {(['7d', '30d', '90d'] as const).map((r) => {
        const isActive = currentRange === r
        return (
          <Link
            key={r}
            href={`/?range=${r}`}
            className={`px-3 py-1 rounded transition-colors ${
              isActive
                ? 'bg-ink text-white font-medium'
                : 'text-ink-muted hover:text-ink hover:bg-line-soft'
            }`}
          >
            Last {r.replace('d', ' days')}
          </Link>
        )
      })}
    </div>
  )
}
