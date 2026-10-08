import { Pill, type PillTone } from '@/components/dashboard/primitives'
import { STAGE_LABELS } from '@/lib/leads/filters'
import type { Stage, VerificationStatus } from '@/lib/leads/types'

const VERIF: Record<VerificationStatus, { tone: PillTone; label: string }> = {
  valid: { tone: 'good', label: 'Valid' },
  invalid: { tone: 'bad', label: 'Invalid' },
  catch_all: { tone: 'warn', label: 'Catch-all' },
  risky: { tone: 'warn', label: 'Risky' },
  unknown: { tone: 'neutral', label: 'Unknown' },
  unverified: { tone: 'neutral', label: 'Unverified' },
}

export function VerificationPill({ status }: { status: VerificationStatus | null }) {
  if (!status) return null
  const v = VERIF[status]
  return <Pill tone={v.tone}>{v.label}</Pill>
}

const STAGE_TONE: Partial<Record<Stage, PillTone>> = {
  interested: 'good',
  meeting: 'good',
  won: 'good',
  replied: 'accent',
  lost: 'neutral',
  do_not_contact: 'bad',
}

export function StagePill({ stage }: { stage: Stage }) {
  return <Pill tone={STAGE_TONE[stage] ?? 'neutral'}>{STAGE_LABELS[stage]}</Pill>
}

const RESEARCH_LABEL: Record<string, { tone: PillTone; label: string }> = {
  needs_research: { tone: 'neutral', label: 'Needs research' },
  queued: { tone: 'accent', label: 'Queued' },
  researching: { tone: 'accent', label: 'Researching' },
  researched: { tone: 'good', label: 'Researched' },
  failed: { tone: 'bad', label: 'Research failed' },
  skipped: { tone: 'neutral', label: 'Skipped' },
}

export function ResearchPill({ status }: { status: string }) {
  const r = RESEARCH_LABEL[status] ?? { tone: 'neutral' as const, label: status }
  return <Pill tone={r.tone}>{r.label}</Pill>
}

/** "Baltimore, MD" / "MD" / null */
export function place(city: string | null, state: string | null): string | null {
  const parts = [city?.trim(), state?.trim()?.toUpperCase()].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: process.env.DASHBOARD_TZ || 'America/New_York' })
const DATETIME_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: process.env.DASHBOARD_TZ || 'America/New_York',
})

export function shortDate(d: Date | string | null): string {
  if (!d) return '—'
  return DATE_FMT.format(new Date(d))
}
export function dateTime(d: Date | string | null): string {
  if (!d) return '—'
  return DATETIME_FMT.format(new Date(d))
}
