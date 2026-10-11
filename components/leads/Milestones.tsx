import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { dateTime } from '@/components/leads/pills'
import type { Milestones as MilestonesData } from '@/lib/leads/profile'

const ROWS: { key: keyof MilestonesData; label: string }[] = [
  { key: 'first_touch', label: 'First touch' },
  { key: 'first_open', label: 'First open' },
  { key: 'first_reply', label: 'First reply' },
  { key: 'last_activity', label: 'Last activity' },
]

/** First touch, first open, first reply, last activity (plan 2.10) -- from lp.lead_events
 *  and lp.campaign_touches only; a milestone that never happened reads "Not yet", never a date. */
export function Milestones({ data }: { data: MilestonesData }) {
  const any = ROWS.some((r) => data[r.key])
  return (
    <Card className="p-4">
      <SectionHeader title="Milestones" />
      {any ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-4">
          {ROWS.map((r) => (
            <div key={r.key}>
              <dt className="text-[11px] uppercase tracking-[0.04em] text-ink-faint">{r.label}</dt>
              <dd className="mt-0.5 text-ink">{data[r.key] ? dateTime(data[r.key]) : 'Not yet'}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <EmptyNote>Nothing recorded yet.</EmptyNote>
      )}
    </Card>
  )
}
