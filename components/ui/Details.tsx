import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from './cn'

/**
 * Collapsible "Details" / "For admins" section (native <details>, so it works
 * without JavaScript and its content stays in the page for search and tests).
 * Technical detail -- job ids, schedules, environment variable names, source
 * tables -- lives here so it is never lost and never in the way.
 */
export function Details({
  summary = 'Details',
  children,
  defaultOpen = false,
  className,
  tone = 'plain',
  testId,
}: {
  summary?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
  tone?: 'plain' | 'admin'
  testId?: string
}) {
  return (
    <details open={defaultOpen || undefined} className={cn('group/details', className)} data-testid={testId}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-control py-1 text-xs font-medium text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-md:min-h-tap [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open/details:rotate-180" />
        {summary}
      </summary>
      <div
        className={cn(
          'mt-2 text-xs leading-relaxed text-ink-muted',
          tone === 'admin' && 'rounded-control border border-line-soft bg-surface-2 px-3 py-2.5 [&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:font-mono [&_code]:text-2xs',
        )}
      >
        {children}
      </div>
    </details>
  )
}

/** Shorthand: the "For admins" variant. */
export function ForAdmins({ children, className, summary = 'For admins', testId }: { children: ReactNode; className?: string; summary?: ReactNode; testId?: string }) {
  return (
    <Details summary={summary} tone="admin" className={className} testId={testId}>
      {children}
    </Details>
  )
}
