import type { ReactNode } from 'react'
import Link from 'next/link'
import { cn } from './cn'

/**
 * One number with its label and a one-line note. `value` null renders the
 * house "—" (not reported), never 0. Optional href makes the card a drill-down.
 */
export function StatCard({
  label,
  value,
  note,
  href,
  tone,
  icon,
  className,
}: {
  label: ReactNode
  value: ReactNode
  note?: ReactNode
  href?: string
  tone?: 'accent' | 'warn' | 'good' | 'bad'
  icon?: ReactNode
  className?: string
}) {
  const valueTone = tone === 'accent' ? 'text-accent' : tone === 'warn' ? 'text-warn' : tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : 'text-ink'
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-muted group-hover:text-ink">{label}</span>
        {icon ? <span className="text-ink-faint [&_svg]:h-4 [&_svg]:w-4">{icon}</span> : null}
      </div>
      <span className={cn('mt-2 block text-metric font-semibold tabular-nums', valueTone)}>
        {value === null || value === undefined ? <span className="text-unavailable" title="Not reported">—</span> : value}
      </span>
      {note ? <span className="mt-1 block text-xs leading-snug text-ink-faint">{note}</span> : null}
    </>
  )
  const base = cn('group flex min-w-0 flex-col rounded-card border border-line bg-surface px-4 py-3.5 shadow-card', className)
  if (href) {
    return (
      <Link href={href} prefetch={false} className={cn(base, 'transition-colors hover:border-ink-faint/50 hover:bg-surface-2/60')}>
        {inner}
      </Link>
    )
  }
  return <div className={base}>{inner}</div>
}

export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4', className)}>{children}</div>
}
