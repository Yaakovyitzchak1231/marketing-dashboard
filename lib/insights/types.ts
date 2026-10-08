import type { DashboardData, Insight } from '@/lib/dashboard/types'

/** What computeInsights receives: everything the data layer assembled, minus insights. */
export type InsightInput = Omit<DashboardData, 'insights'>

/**
 * Internal: an insight plus its rank inside its severity band. `impact` is
 * stripped before the list leaves computeInsights. Higher = shown first.
 * Each rule's base impact is listed in RULE_IMPACT (index.ts docs).
 */
export interface RankedInsight extends Insight {
  impact: number
}

/** Rank inside a severity band. Bases are spaced by 100 so magnitude (0..99) never crosses rules. */
export const RULE_IMPACT = {
  leadWaiting: 900,
  sendingStalled: 850,
  accountError: 800,
  totalBounce: 780,
  accountBounce: 760,
  campaignError: 740,
  campaignOutOfLeads: 700,
  replyTrend: 650,
  positiveTrend: 640,
  volumeDrop: 620,
  campaignZeroReplies: 600,
  campaignGap: 560,
  variantWinner: 540,
  deadStep: 520,
  campaignLowRunway: 500,
  warmup: 480,
  loadBalance: 440,
  unlabeledWaiting: 420,
  stepMix: 400,
  bestCampaign: 380,
  bestPositiveCampaign: 370,
  bestSubject: 360,
  accountPaused: 300,
  idleAccounts: 280,
  campaignsCompleted: 260,
  tooEarly: 100,
} as const

/** Clamp a magnitude into 0..99 so it only orders cards within one rule. */
export function mag(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0
  return Math.min(99, x)
}
