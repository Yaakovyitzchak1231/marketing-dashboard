import type { ReactNode } from 'react'
import { DASH, NOT_REPORTED } from './format'

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

export function SectionHeader({ title, meta, id }: { title: string; meta?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 id={id} className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-muted">
        {title}
      </h2>
      {meta ? <div className="text-[12px] text-ink-faint">{meta}</div> : null}
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-card border border-line bg-surface shadow-card ${className}`}>{children}</div>
}

const PILL_TONES = {
  good: 'border-good/30 bg-good-soft text-good',
  warn: 'border-warn/30 bg-warn-soft text-warn',
  bad: 'border-bad/30 bg-bad-soft text-bad',
  accent: 'border-accent/30 bg-accent-soft text-accent',
  neutral: 'border-line bg-canvas text-ink-muted',
} as const

export type PillTone = keyof typeof PILL_TONES

export function Pill({ tone, children, title }: { tone: PillTone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-[1px] text-[11px] font-medium leading-[18px] ${PILL_TONES[tone]}`}
    >
      {children}
    </span>
  )
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-[13px] text-ink-faint">{children}</p>
}
