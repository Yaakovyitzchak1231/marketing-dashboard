import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import type { EngagementSection } from '@/lib/leads/profile'

const COLS: { key: 'opens' | 'replies' | 'steps'; label: string }[] = [
  { key: 'steps', label: 'Emails sent' },
  { key: 'opens', label: 'Opens' },
  { key: 'replies', label: 'Replies' },
]

/** Engagement tab (plan 2.10): this lead vs. its campaign's average, counted straight
 *  from lp.lead_events -- never a guess. "available: false" just means no campaign
 *  has recorded events for this lead yet. */
export function EngagementPanel({ data }: { data: EngagementSection }) {
  if (!data.benchmarks.length) {
    return (
      <Card className="p-4">
        <SectionHeader title="Engagement" />
        <EmptyNote>No campaign activity recorded for this lead yet.</EmptyNote>
      </Card>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {data.benchmarks.map((b) => (
        <Card key={b.campaign_id} className="p-4">
          <SectionHeader title={b.campaign_name} meta="this lead vs. the campaign average" />
          <div className="grid grid-cols-3 gap-3">
            {COLS.map((c) => {
              const mine = b.lead[c.key]
              const avg = b.campaign_average[c.key]
              const ahead = avg > 0 ? mine >= avg : mine > 0
              return (
                <div key={c.key} className="min-w-0 rounded-card border border-line-soft p-2 text-center xs:p-3">
                  <div className="text-[11px] uppercase tracking-[0.04em] text-ink-faint">{c.label}</div>
                  <div className="mt-1 text-[20px] font-semibold text-ink">{mine}</div>
                  <div className={`mt-0.5 text-[12px] ${ahead ? 'text-good' : 'text-ink-faint'}`}>campaign avg {avg}</div>
                </div>
              )
            })}
          </div>
        </Card>
      ))}
    </div>
  )
}
