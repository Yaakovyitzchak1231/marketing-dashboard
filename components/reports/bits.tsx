import { Pill, type PillTone } from '@/components/dashboard/primitives'
import { LEVEL_WORDS, type RunwayLevel } from '@/lib/reports/runway'
import { formatCount, formatPct } from '@/components/dashboard/format'

export function SampleBanner() {
  return (
    <p className="mb-4 rounded-control border border-warn/30 bg-warn-soft px-3 py-2 text-xs font-medium text-warn">
      SAMPLE DATA (local preview only). These Instantly numbers are a test fixture, not your campaigns.
    </p>
  )
}

export function SourceErrors({ errors }: { errors: string[] }) {
  if (!errors.length) return null
  return (
    <ul className="mb-4 space-y-1 rounded-control border border-line bg-surface px-3 py-2 text-xs text-ink-muted">
      {errors.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  )
}

const LEVEL_TONE: Record<RunwayLevel, PillTone> = { ok: 'good', low: 'warn', out: 'bad', not_sending: 'neutral', no_data: 'neutral' }
export function LevelPill({ level }: { level: RunwayLevel }) {
  return <Pill tone={LEVEL_TONE[level]}>{LEVEL_WORDS[level]}</Pill>
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US')
export const fmtUsd = (n: number) => (n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString('en-US')}`)

/** A count that may be unreported: "no data" for null, never 0. */
export function Count({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <span className="text-unavailable">no data</span>
  return <>{formatCount(v)}</>
}

/** A 0..1 rate that may be unreported. */
export function Pct({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <span className="text-unavailable">no data</span>
  return <>{formatPct(v)}</>
}

export const TH = 'px-3 py-2 text-left text-2xs font-semibold uppercase tracking-[0.05em] text-ink-faint'
export const TD = 'px-3 py-2 align-top text-sm text-ink'
export const TDN = 'px-3 py-2 align-top text-right font-numeric tabular-nums text-sm text-ink'
