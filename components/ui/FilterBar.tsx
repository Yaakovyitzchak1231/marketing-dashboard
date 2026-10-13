import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from './cn'

/** A filter chip. Active chips are filled; they read as filters, not buttons. */
export function Chip({
  href,
  active,
  children,
  count,
  className,
}: {
  href: string
  active?: boolean
  children: ReactNode
  count?: number | null
  className?: string
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors max-md:min-h-[2.5rem]',
        active ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-surface text-ink-muted hover:border-ink-faint/50 hover:text-ink',
        className,
      )}
    >
      {children}
      {count != null ? <span className={cn('tabular-nums', active ? 'text-accent/80' : 'text-ink-faint')}>{count.toLocaleString('en-US')}</span> : null}
    </Link>
  )
}

/**
 * A labelled row of chips. On phones it scrolls sideways instead of wrapping
 * into four rows.
 */
export function FilterBar({ label, children, className }: { label?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      {label ? <span className="shrink-0 text-xs font-medium text-ink-faint">{label}</span> : null}
      <div role="group" aria-label={typeof label === 'string' ? label : undefined} className="no-scrollbar -mx-1 flex min-w-0 items-center gap-1.5 overflow-x-auto px-1 py-0.5">
        {children}
      </div>
    </div>
  )
}
