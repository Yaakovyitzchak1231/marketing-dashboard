import type { ReactNode } from 'react'
import { cn } from './cn'

/** What's missing, why it matters, and the one thing to do about it. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
  compact?: boolean
}) {
  return (
    <div className={cn('flex flex-col items-center text-center', compact ? 'px-4 py-6' : 'px-6 py-10', className)}>
      {icon ? <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-ink-faint [&_svg]:h-5 [&_svg]:w-5">{icon}</div> : null}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description ? <p className="mt-1 max-w-md text-sm text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  )
}

/** A recoverable error, said plainly. */
export function ErrorState({ title = 'This part didn’t load', description, action }: { title?: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="rounded-card border border-bad/25 bg-bad-soft px-4 py-3 text-sm text-bad">
      <p className="font-semibold">{title}</p>
      {description ? <p className="mt-0.5 text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

/** A neutral or cautionary notice band. */
export function Callout({ tone = 'neutral', title, children, action, className }: { tone?: 'neutral' | 'warn' | 'good' | 'bad' | 'accent'; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const t = {
    neutral: 'border-line bg-surface-2 text-ink',
    warn: 'border-warn/25 bg-warn-soft text-ink',
    good: 'border-good/25 bg-good-soft text-ink',
    bad: 'border-bad/25 bg-bad-soft text-ink',
    accent: 'border-accent/25 bg-accent-soft text-ink',
  }[tone]
  return (
    <div className={cn('flex flex-col gap-2 rounded-card border px-4 py-3 sm:flex-row sm:items-center sm:justify-between', t, className)}>
      <div className="min-w-0 text-sm">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="text-ink-muted">{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap gap-2">{action}</div> : null}
    </div>
  )
}
