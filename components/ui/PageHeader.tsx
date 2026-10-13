import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { cn } from './cn'

/**
 * Every screen's title row: title, ONE line saying what the page is for, and
 * a single primary action (secondary actions go in `secondary`).
 */
export function PageHeader({
  title,
  description,
  meta,
  primary,
  secondary,
  back,
  className,
}: {
  title: ReactNode
  /** One line: what this page is for. */
  description?: ReactNode
  /** Live context under the purpose line (counts, freshness). */
  meta?: ReactNode
  primary?: ReactNode
  secondary?: ReactNode
  back?: { href: string; label: string }
  className?: string
}) {
  return (
    <header className={cn('mb-6 flex flex-col gap-4 sm:mb-8 md:flex-row md:items-end md:justify-between', className)}>
      <div className="min-w-0">
        {back ? (
          <Link href={back.href} prefetch={false} className="-ml-1 mb-2 inline-flex items-center gap-0.5 rounded-control px-1 py-0.5 text-xs font-medium text-ink-muted hover:text-ink">
            <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
            {back.label}
          </Link>
        ) : null}
        <h1 className="text-2xl font-semibold text-ink [overflow-wrap:anywhere]">{title}</h1>
        {description ? <p className="mt-1 max-w-prose text-sm text-ink-muted [overflow-wrap:anywhere]">{description}</p> : null}
        {meta ? <div className="mt-1.5 text-xs text-ink-faint [overflow-wrap:anywhere]">{meta}</div> : null}
      </div>
      {primary || secondary ? (
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          {secondary}
          {primary}
        </div>
      ) : null}
    </header>
  )
}

/** A titled section of a page: a heading, an optional line, an optional action. */
export function Section({
  title,
  description,
  action,
  id,
  children,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  id?: string
  children: ReactNode
  className?: string
}) {
  const hid = id ? `${id}-h` : undefined
  return (
    <section id={id} aria-labelledby={hid} className={cn('scroll-mt-20', className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 id={hid} className="text-base font-semibold text-ink [overflow-wrap:anywhere]">
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-xs text-ink-faint">{description}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2 text-xs">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}
