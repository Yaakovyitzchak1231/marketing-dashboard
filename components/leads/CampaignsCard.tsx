import Link from 'next/link'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { shortDate } from '@/components/leads/pills'
import type { CampaignsSection } from '@/lib/leads/profile'

/** Campaigns card (plan 2.10): every campaign this lead has been added to, with status. */
export function CampaignsCard({ data }: { data: CampaignsSection }) {
  return (
    <Card className="p-4">
      <SectionHeader title="Campaigns" />
      {!data.available ? (
        <EmptyNote>{data.needs_migration}</EmptyNote>
      ) : !data.memberships.length ? (
        <EmptyNote>Not in any campaign yet.</EmptyNote>
      ) : (
        <ul className="divide-y divide-line-soft text-[13px]">
          {data.memberships.map((m) => (
            <li key={m.campaign_id} className="flex items-center justify-between gap-2 py-1.5">
              <Link href={`/campaigns/${m.campaign_id}`} className="min-w-0 text-ink hover:underline [overflow-wrap:anywhere]">
                {m.campaign_name}
              </Link>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-[12px] text-ink-faint">{shortDate(m.added_at)}</span>
                <Pill tone={m.status === 'active' ? 'good' : 'neutral'}>{m.status}</Pill>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
