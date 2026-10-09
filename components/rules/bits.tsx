import type { Tier } from '@/lib/rules/evaluate'
import { Pill } from '@/components/dashboard/primitives'

const TONE: Record<Tier, 'good' | 'accent' | 'warn'> = { ready_personalized: 'good', ready_generic: 'accent', parked: 'warn' }
const WORDS: Record<Tier, string> = { ready_personalized: 'Ready-personalized', ready_generic: 'Ready-generic', parked: 'Parked' }

export function TierPill({ tier }: { tier: Tier }) {
  return <Pill tone={TONE[tier]}>{WORDS[tier]}</Pill>
}

export const SCOPE_WORDS: Record<string, string> = { default: 'Default', pool: 'Pool', campaign: 'Campaign', template: 'Template' }

export function Notice({ error, saved }: { error?: string | null; saved?: string | null }) {
  if (!error && !saved) return null
  return (
    <p role={error ? 'alert' : 'status'} className={`mb-4 rounded-card border px-3 py-2 text-[12.5px] ${error ? 'border-bad/30 bg-bad-soft text-bad' : 'border-good/30 bg-good-soft text-good'}`}>
      {error ?? saved}
    </p>
  )
}
