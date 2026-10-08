/**
 * Test-only builders for the insights engine. Nothing here is reachable from the app.
 */
import type {
  CampaignRow, Counts, DailyPoint, DashboardData, Rates, RepliedLead, SenderAccount, StepStat,
} from '@/lib/dashboard/types'

export type Input = Omit<DashboardData, 'insights'>

export function counts(p: Partial<Counts> = {}): Counts {
  return {
    sent: null, contacted: null, opened: null, clicked: null, replied: null, autoReplies: null,
    bounced: null, unsubscribed: null, positive: null, meetingsBooked: null, opportunityValue: null,
    ...p,
  }
}

/** Rates derived the contract's way, so fixtures stay internally consistent. */
export function ratesFrom(c: Counts): Rates {
  const r = (k: number | null, n: number | null) => (k == null || n == null || n <= 0 ? null : k / n)
  return {
    replyRate: r(c.replied, c.contacted),
    positiveRate: r(c.positive, c.contacted),
    positiveShareOfReplies: r(c.positive, c.replied),
    bounceRate: r(c.bounced, c.sent),
    openRate: r(c.opened, c.contacted),
    clickRate: r(c.clicked, c.contacted),
    unsubscribeRate: r(c.unsubscribed, c.contacted),
  }
}

export function step(p: Partial<StepStat> & { step: number; variant: string }): StepStat {
  const s: StepStat = { subject: null, sent: null, opened: null, replied: null, positive: null, replyRate: null, ...p }
  if (s.replyRate == null && s.replied != null && s.sent) s.replyRate = s.replied / s.sent
  return s
}

export function campaign(
  id: string,
  p: Partial<Omit<CampaignRow, 'counts' | 'rates' | 'lifetime'>> & { counts?: Partial<Counts>; lifetime?: Partial<Counts> | null } = {},
): CampaignRow {
  const c = counts(p.counts)
  const row: CampaignRow = {
    id,
    name: p.name ?? `Campaign ${id}`,
    status: p.status ?? 'active',
    openTracking: p.openTracking ?? false,
    counts: c,
    rates: ratesFrom(c),
    steps: p.steps ?? [],
    leadsTotal: p.leadsTotal ?? null,
    leadsRemaining: p.leadsRemaining ?? null,
  }
  if (p.lifetime !== undefined) {
    if (p.lifetime === null) row.lifetime = null
    else {
      const lc = counts(p.lifetime)
      row.lifetime = { counts: lc, rates: ratesFrom(lc) }
    }
  }
  return row
}

export function account(email: string, p: Partial<Omit<SenderAccount, 'email' | 'health' | 'healthReason'>> = {}): SenderAccount {
  const sent = p.sent ?? null
  const bounced = p.bounced ?? null
  return {
    email,
    status: p.status ?? 'active',
    warmupScore: p.warmupScore ?? null,
    dailyLimit: p.dailyLimit ?? null,
    sent,
    bounced,
    replied: p.replied ?? null,
    bounceRate: p.bounceRate !== undefined ? p.bounceRate : sent && bounced != null ? bounced / sent : null,
    health: 'unknown',
    healthReason: '',
  }
}

export function lead(email: string, p: Partial<Omit<RepliedLead, 'email'>> = {}): RepliedLead {
  return {
    email,
    name: null,
    company: null,
    campaignId: null,
    campaignName: null,
    interest: 'interested',
    lastReplyAt: null,
    lastReplySnippet: null,
    awaitingOurReply: true,
    daysWaiting: null,
    ...p,
  }
}

export function day(date: string, sent: number | null, p: Partial<DailyPoint> = {}): DailyPoint {
  return { date, sent, contacted: null, replied: null, positive: null, bounced: null, opened: null, ...p }
}

export const GENERATED_AT = '2026-10-08T16:00:00.000Z' // 12:00 noon in New York

export function input(p: Partial<Input> = {}): Input {
  const totals = p.totals ?? { counts: counts(), rates: ratesFrom(counts()) }
  return {
    generatedAt: GENERATED_AT,
    range: { key: '30d', start: '2026-09-09', end: '2026-10-08', timezone: 'America/New_York' },
    configured: true,
    totals,
    previous: null,
    daily: [],
    campaigns: [],
    accounts: [],
    repliedLeads: [],
    errors: [],
    ...p,
  }
}

export function totals(p: Partial<Counts>): { counts: Counts; rates: Rates } {
  const c = counts(p)
  return { counts: c, rates: ratesFrom(c) }
}
