import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from './cn'

/**
 * URL-driven segmented control (server-rendered): each option is a link, the
 * current one is marked aria-current. Used for views and sub-areas.
 */
export function LinkTabs({ items, label, className }: { items: { href: string; label: ReactNode; active: boolean; count?: number | null }[]; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={cn('no-scrollbar -mx-1 overflow-x-auto px-1', className)}>
      <ul className="inline-flex items-center gap-1 rounded-control border border-line bg-surface-2 p-1">
        {items.map((it) => (
          <li key={it.href} className="shrink-0">
            <Link
              href={it.href}
              prefetch={false}
              aria-current={it.active ? 'page' : undefined}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-3 text-sm font-medium transition-colors max-md:min-h-[2.5rem]',
                it.active ? 'bg-surface text-ink shadow-card' : 'text-ink-muted hover:text-ink',
              )}
            >
              {it.label}
              {it.count != null ? <span className="tabular-nums text-xs text-ink-faint">{it.count.toLocaleString('en-US')}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
