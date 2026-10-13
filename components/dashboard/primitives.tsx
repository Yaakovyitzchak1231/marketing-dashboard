import type { ReactNode } from 'react'
import type { HTMLAttributes } from 'react'
import { DASH, NOT_REPORTED } from './format'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { cn } from '@/components/ui/cn'

/** A value that may be unreported. null renders "—" with a tooltip, never 0. */
export function Val({ value, children }: { value: unknown; children: ReactNode }) {
  if (value === null || value === undefined) {
    return (
      <span className="text-unavailable" title={NOT_REPORTED} aria-label={NOT_REPORTED}>
        {DASH}
      </span>
    )
  }
  return <>{children}</>
}

/** Section title: sentence case, one size, an optional action on the right. */
export function SectionHeader({ title, meta, id }: { title: string; meta?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
      <h2 id={id} className="min-w-0 text-base font-semibold text-ink [overflow-wrap:anywhere]">
        {title}
      </h2>
      {meta ? <div className="text-xs text-ink-faint">{meta}</div> : null}
    </div>
  )
}

export function Card({ children, className = '', ...props }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-card border border-line bg-surface shadow-card', className)} {...props}>
      {children}
    </div>
  )
}

export type PillTone = BadgeTone

/** Status pill -- the design system's Badge under its old name. */
export function Pill({ tone, children, title }: { tone: PillTone; children: ReactNode; title?: string }) {
  return (
    <Badge tone={tone} title={title}>
      {children}
    </Badge>
  )
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-4 py-10 text-center text-sm text-ink-muted">{children}</p>
}
