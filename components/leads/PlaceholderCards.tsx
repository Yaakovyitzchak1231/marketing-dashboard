import { Card, SectionHeader } from '@/components/dashboard/primitives'
import type { LeadProfile } from '@/lib/leads/profile'

/** Journeys / Deals / Conversions (plan 2.10): honest "Not built yet" until 3.x/4.x
 *  land -- never a fake number standing in for a feature that isn't there. */
export function PlaceholderCards({ placeholders }: { placeholders: LeadProfile['placeholders'] }) {
  const rows: { label: string; note: string }[] = [
    { label: 'Journeys', note: placeholders.journeys },
    { label: 'Deals', note: placeholders.deals },
    { label: 'Conversions', note: placeholders.conversions },
  ]
  return (
    <Card className="p-4">
      <SectionHeader title="Coming later" />
      <dl className="grid grid-cols-3 gap-3 text-[13px]">
        {rows.map((r) => (
          <div key={r.label}>
            <dt className="text-[11px] uppercase tracking-[0.04em] text-ink-faint">{r.label}</dt>
            <dd className="mt-0.5 text-ink-faint">{r.note}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}
