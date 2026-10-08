/**
 * Shaped after Yaakov's real 30-day Instantly numbers on 2026-10-08 (counts as
 * the API returned them), with campaign names, ids and emails ANONYMIZED.
 * - One long-running test campaign is the only real sender: 495 new leads, 10 human
 *   replies, 11 auto-replies, 5 bounces, 0 opportunities in 30d.
 * - A campaign launched the day before: 210 contacted, 0 replies.
 * - Older completed campaigns sent nothing in 30d but have big lifetime results
 *   (the best: 11,746 leads -> 1,357 replies -> 951 opportunities).
 * - Open tracking off everywhere.
 */
import { account, campaign, day, input, step, totals } from './builders'

const followupDays = (): ReturnType<typeof day>[] => {
  const out = []
  const start = Date.parse('2026-09-24T00:00:00Z')
  for (let i = 0; i < 15; i++) {
    const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10)
    // Days 09-25..09-27 omitted by Instantly -> data layer fills 0.
    const sent = ['2026-09-25', '2026-09-26', '2026-09-27'].includes(d) ? 0 : 150 + (i % 4) * 20
    out.push(day(d, sent))
  }
  return out
}

export const realShaped30d = input({
  totals: totals({ sent: 2618, contacted: 705, replied: 10, autoReplies: 11, bounced: 6, positive: 0, meetingsBooked: 0, opened: null, opportunityValue: 0 }),
  previous: null,
  daily: followupDays(),
  campaigns: [
    campaign('c-test', {
      name: 'Retailers - Test 01',
      status: 'active',
      counts: { sent: 2408, contacted: 495, replied: 10, autoReplies: 11, bounced: 5, positive: 0, opened: null },
      leadsTotal: 495,
      leadsRemaining: 6,
      steps: [
        step({ step: 1, variant: 'A', subject: 'quick question', sent: 495, replied: 7 }),
        step({ step: 2, variant: 'A', subject: null, sent: 490, replied: 2 }),
        step({ step: 3, variant: 'A', subject: null, sent: 480, replied: 1 }),
        step({ step: 4, variant: 'A', subject: null, sent: 470, replied: 0 }),
      ],
      lifetime: { sent: 2408, contacted: 495, replied: 10, autoReplies: 11, bounced: 5, positive: 0 },
    }),
    campaign('c-seg3', {
      name: 'Segment 3 Cashback',
      status: 'active',
      counts: { sent: 210, contacted: 210, replied: 0, autoReplies: 0, bounced: 1, positive: 0 },
      leadsTotal: 211,
      leadsRemaining: 1,
      lifetime: { sent: 210, contacted: 210, replied: 0, bounced: 1, positive: 0 },
    }),
    campaign('c-pb', {
      name: 'Signups / Leads',
      status: 'completed',
      counts: { sent: 0, contacted: 0, replied: 0, bounced: 0, positive: 0 },
      steps: [],
      lifetime: { sent: 31893, contacted: 11746, replied: 1357, autoReplies: 8, bounced: 85, positive: 951 },
    }),
    campaign('c-ertc', {
      name: 'Funding Contacts',
      status: 'completed',
      counts: { sent: 0, contacted: 0, replied: 0, bounced: 0, positive: 0 },
      lifetime: { sent: 9452, contacted: 4377, replied: 143, autoReplies: 19, bounced: 79, positive: 112 },
    }),
    campaign('c-qual', {
      name: 'Qualified',
      status: 'completed',
      counts: { sent: 0, contacted: 0, replied: 0, bounced: 0, positive: 0 },
      lifetime: { sent: 1200, contacted: 515, replied: 260, bounced: 4, positive: 200 },
    }),
  ],
  accounts: [
    account('sender1@example.com', { status: 'active', warmupScore: 100, dailyLimit: 30, sent: 1300, bounced: 3 }),
    account('sender2@example.com', { status: 'active', warmupScore: 100, dailyLimit: 30, sent: 1318, bounced: 3 }),
  ],
  repliedLeads: [],
})
