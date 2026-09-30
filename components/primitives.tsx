import { type ReactNode } from 'react'
import { isUnavailable } from '@/lib/format'

/**
 * Shared primitives. Each one encodes a piece of the design standard so the
 * shell sections stay consistent and the anti-slop rules are not re-decided
 * per component.
 */

/**
 * A surface with a hairline border. Cards are separated by a 1px line, not a
 * shadow -- this is the single biggest difference between a designed screen
 * and dashboard chrome.
 */
export function Card({
  children,
  className = '',
  testId,
}: {
  children: ReactNode
  className?: string
  testId?: string
}) {
  return (
    <section
      data-testid={testId}
      className={`rounded-card border border-line bg-surface shadow-card ${className}`}
    >
      {children}
    </section>
  )
}

/**
 * Section heading. @build-copy owns the words; this owns the type treatment:
 * small, tracked, uppercase, muted. It is a label, not a headline.
 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
      {children}
    </h2>
  )
}

/**
 * A value that is not available.
 *
 * Rendered as a dash in the muted unavailable colour, and marked
 * `data-unavailable` so the absence is machine-readable -- a QA check can
 * assert on the attribute rather than scraping for a glyph. Crucially this is
 * styled as a *muted* state, never as a zero, because a dash that looks like a
 * zero is a lie the same way "0.0%" is.
 */
export function Unavailable({ testId }: { testId?: string }) {
  return (
    <span
      data-testid={testId}
      data-unavailable="true"
      title="Not reported by the source"
      className="text-unavailable"
    >
      —
    </span>
  )
}

/** A number rendered with tabular figures so columns align digit-for-digit. */
export function Figure({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <span className={`font-numeric tabular-nums ${className}`}>{children}</span>
}

/**
 * Renders a numeric value, or the unavailable state when it is null/undefined.
 *
 * This is the only sanctioned way to put a number on screen, which is how
 * "never fabricate a metric" becomes structural rather than a convention.
 */
export function Metric({
  value,
  format,
}: {
  value: number | null | undefined
  format: (v: number) => string
}) {
  if (isUnavailable(value)) return <Unavailable />
  return <Figure>{format(value)}</Figure>
}
