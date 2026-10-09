import type { ReactNode } from 'react'
import { Pill, type PillTone } from '@/components/dashboard/primitives'
import type { Tier } from '@/lib/campaigns/evaluator'
import { TIER_WORDS } from '@/lib/campaigns/evaluator'

export const INPUT = 'rounded-card border border-line bg-surface px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-muted'
export const LABEL = 'flex flex-col gap-1 text-[12px] text-ink-muted'

const TIER_TONE: Record<Tier, PillTone> = { ready_personalized: 'good', ready_generic: 'accent', parked: 'warn' }

export function TierPill({ tier }: { tier: Tier | null }) {
  if (!tier) return <Pill tone="neutral" title="The rules have not scored this lead yet">Not scored yet</Pill>
  return <Pill tone={TIER_TONE[tier]}>{TIER_WORDS[tier]}</Pill>
}

export function Notice({ tone, children }: { tone: 'good' | 'bad'; children: ReactNode }) {
  return (
    <p
      role={tone === 'bad' ? 'alert' : 'status'}
      className={`mb-4 rounded-card border px-3 py-2 text-[13px] ${tone === 'bad' ? 'border-bad/30 bg-bad-soft text-bad' : 'border-good/30 bg-good-soft text-good'}`}
    >
      {children}
    </p>
  )
}
