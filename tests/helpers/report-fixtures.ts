import type { CampaignRow, Counts } from '@/lib/dashboard/types'

export function counts(p: Partial<Counts> = {}): Counts {
  return {
    sent: null,
    contacted: null,
    opened: null,
    clicked: null,
    replied: null,
    autoReplies: null,
    bounced: null,
    unsubscribed: null,
    positive: null,
    meetingsBooked: null,
    opportunityValue: null,
    ...p,
  }
}

export function campaign(id: string, p: Partial<CampaignRow> & { c?: Partial<Counts> } = {}): CampaignRow {
  const { c, ...rest } = p
  return {
    id,
    name: `Campaign ${id}`,
    status: 'active',
    openTracking: false,
    counts: counts(c),
    rates: { replyRate: null, positiveRate: null, positiveShareOfReplies: null, bounceRate: null, openRate: null, clickRate: null, unsubscribeRate: null },
    steps: [],
    leadsTotal: null,
    leadsRemaining: null,
    ...rest,
  }
}
