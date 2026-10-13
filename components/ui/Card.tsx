import type { HTMLAttributes, ReactNode } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { cn } from './cn'

/** shadcn Card on this project's tokens: hairline border, soft shadow, 12px radius. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-card border border-line bg-surface shadow-card', className)} {...props} />
}

export function CardHeader({
  title,
  description,
  action,
  className,
  id,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
  id?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line-soft px-4 py-3 sm:px-5', className)}>
      <div className="min-w-0">
        <h3 id={id} className="text-sm font-semibold text-ink">
          {title}
        </h3>
        {description ? <p className="mt-0.5 text-xs text-ink-faint">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  )
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-4 sm:px-5', className)} {...props} />
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-4 py-3 sm:px-5', className)} {...props} />
}

/** A whole-card link to a drill-down: title, a line of description, a chevron. */
export function LinkCard({ href, title, description, meta, className }: { href: string; title: ReactNode; description?: ReactNode; meta?: ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={cn('group flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 shadow-card transition-colors hover:border-ink-faint/50 hover:bg-surface-2/60 sm:px-5', className)}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {description ? <p className="mt-0.5 text-xs leading-snug text-ink-muted">{description}</p> : null}
        {meta ? <div className="mt-1.5 text-xs text-ink-faint">{meta}</div> : null}
      </div>
      <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
    </Link>
  )
}
