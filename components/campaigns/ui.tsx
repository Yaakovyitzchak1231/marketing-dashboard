import { controlClass } from '@/components/ui/classes'
import type { ReactNode } from 'react'
import { Pill, type PillTone } from '@/components/dashboard/primitives'
import type { Tier } from '@/lib/campaigns/evaluator'
import { TIER_WORDS } from '@/lib/campaigns/evaluator'
import { REASON_WORDS, type SuppressionReason } from '@/lib/suppressions/store'

export const INPUT = controlClass
export const LABEL = 'flex flex-col gap-1.5 text-xs font-medium text-ink'

const TIER_TONE: Record<Tier, PillTone> = { ready_personalized: 'good', ready_generic: 'accent', parked: 'warn' }

/** `suppressedReason` wins over the evaluator's tier: a suppressed lead reads "Parked — suppressed (reason)" regardless of its rules verdict. */
export function TierPill({ tier, suppressedReason }: { tier: Tier | null; suppressedReason?: SuppressionReason | null }) {
  if (suppressedReason) return <Pill tone="warn" title="On the suppression list — never pushed to Instantly">{`Parked — suppressed (${REASON_WORDS[suppressedReason].toLowerCase()})`}</Pill>
  if (!tier) return <Pill tone="neutral" title="The rules have not scored this lead yet">Not scored yet</Pill>
  return <Pill tone={TIER_TONE[tier]}>{TIER_WORDS[tier]}</Pill>
}

export function Notice({ tone, children }: { tone: 'good' | 'bad'; children: ReactNode }) {
  return (
    <p
      role={tone === 'bad' ? 'alert' : 'status'}
      className={`mb-4 rounded-card border px-3 py-2 text-sm ${tone === 'bad' ? 'border-bad/30 bg-bad-soft text-bad' : 'border-good/30 bg-good-soft text-good'}`}
    >
      {children}
    </p>
  )
}
