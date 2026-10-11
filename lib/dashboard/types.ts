/**
 * THE CONTRACT between the data layer (lib/instantly/*), the insights engine
 * (lib/insights/*) and the UI (app/, components/). Every agent codes against
 * these types. Change them only through the lead.
 *
 * Rules that outrank everything (see AGENTS.md):
 *  - null = "Instantly did not report this". 0 = a measured zero. Never coerce.
 *  - Rates are always recomputed from raw counts. Never average a rate.
 *  - No mock data in the app. Fixtures live under tests/ only.
 */

export type RangeKey = '7d' | '14d' | '30d' | '90d' | 'all'

export interface DateRange {
  key: RangeKey | 'custom'
  /** Inclusive, YYYY-MM-DD, in `timezone`. null start = all time. */
  start: string | null
  end: string
  timezone: string // IANA, e.g. America/New_York (env DASHBOARD_TZ)
}

/** Raw counts for a period. Every field null when the API omitted it. */
export interface Counts {
  sent: number | null              // emails sent, all steps
  contacted: number | null         // distinct leads that got step 1 in period
  opened: number | null            // unique opens (null if open tracking off)
  clicked: number | null           // unique clicks (null if link tracking off)
  replied: number | null           // unique leads that replied (humans, autoreplies excluded when API separates them)
  autoReplies: number | null       // unique auto-replies (OOO etc.)
  bounced: number | null
  unsubscribed: number | null
  positive: number | null          // leads marked interested / opportunities
  meetingsBooked: number | null
  opportunityValue: number | null  // $ value of opportunities, if set in Instantly
}

/** Derived rates, 0..1, or null when the denominator is 0/null. */
export interface Rates {
  replyRate: number | null         // replied / contacted
  positiveRate: number | null      // positive / contacted
  positiveShareOfReplies: number | null // positive / replied
  bounceRate: number | null        // bounced / sent
  openRate: number | null          // opened / contacted (null when tracking off)
  clickRate: number | null         // clicked / contacted
  unsubscribeRate: number | null   // unsubscribed / contacted
}

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'error' | 'unknown'

export interface StepStat {
  step: number          // 1-based step number in the sequence
  variant: string       // 'A', 'B', ...
  subject: string | null
  sent: number | null
  opened: number | null
  replied: number | null
  positive: number | null
  replyRate: number | null // replied / sent for that step+variant
}

export interface CampaignRow {
  id: string
  name: string
  status: CampaignStatus
  openTracking: boolean | null
  counts: Counts
  rates: Rates
  steps: StepStat[]      // may be [] if step analytics failed (see errors)
  leadsTotal: number | null
  leadsRemaining: number | null // leads not yet contacted
  lifetime?: { counts: Counts; rates: Rates } | null // all-time totals (GET /campaigns/analytics with no dates)
  /** Every sequence step (incl. upcoming) with dates, plus send days. See lib/dashboard/sequence.ts. */
  plan?: SequencePlan | null
}

/** Campaign sequence plan (lib/dashboard/sequence.ts). */
export interface PlannedStep {
  step: number
  /** Subject of the first enabled variant; null = same thread (follow-up). */
  subject: string | null
  variants: number
  /** Days after a lead's first email that this step goes out (step 1 = 0). */
  dayOffset: number
  /** Emails sent for this step in the range (all variants); null = not reported. */
  sent: number | null
  /** 'sent' once any email for this step went out; 'upcoming' before that. */
  status: 'sent' | 'upcoming'
  /** First day this step went out or is scheduled to go out (YYYY-MM-DD). */
  firstDate: string | null
  /** Next day on or after today this step is scheduled for, if any. */
  nextDate: string | null
}

export interface SendDay {
  date: string
  /** Emails sent that day, all steps. */
  sent: number
  /** Leads that got their first email that day. */
  newLeads: number
}

export interface SequencePlan {
  steps: PlannedStep[]
  /** Days with any send, oldest first. null = daily numbers were not available. */
  days: SendDay[] | null
}

export interface DailyPoint {
  date: string // YYYY-MM-DD in range timezone
  sent: number | null
  contacted: number | null
  replied: number | null
  positive: number | null
  bounced: number | null
  opened: number | null
}

export type AccountHealth = 'healthy' | 'watch' | 'at_risk' | 'unknown'

export interface SenderAccount {
  email: string
  status: string            // Instantly's own status word (active, paused, error...)
  warmupScore: number | null // 0..100 from Instantly
  dailyLimit: number | null
  sent: number | null        // in range, if available
  bounced: number | null
  replied: number | null
  bounceRate: number | null
  health: AccountHealth
  healthReason: string       // plain words, e.g. "4.1% bounce over 30d (limit 2%)"
  /** Campaigns this inbox is a sender on (campaign email_list). undefined/null = campaign list unavailable. */
  campaigns?: { id: string; name: string; status: CampaignStatus }[] | null
  /** true = sender on at least one active campaign; false = on none; null = unknown. */
  inActiveCampaign?: boolean | null
}

export interface RepliedLead {
  email: string
  name: string | null
  company: string | null
  campaignId: string | null
  campaignName: string | null
  interest: 'interested' | 'meeting_booked' | 'meeting_completed' | 'won' | 'not_interested' | 'out_of_office' | 'wrong_person' | 'lost' | 'no_show' | 'unlabeled'
  lastReplyAt: string | null   // ISO
  lastReplySnippet: string | null
  awaitingOurReply: boolean    // their reply is newer than our last email to them
  daysWaiting: number | null
}

export type InsightSeverity = 'win' | 'opportunity' | 'warning' | 'critical'

export interface Insight {
  id: string                 // stable, e.g. 'bounce-high:acct@x.com'
  severity: InsightSeverity
  title: string              // one line, plain words
  detail: string             // the evidence, with the actual numbers
  action: string             // "what to do next", imperative, concrete
  metric?: { label: string; value: string }
  entity?: { kind: 'campaign' | 'account' | 'step' | 'lead'; id: string; name: string }
}

export interface SourceError {
  source: string   // e.g. 'campaigns/analytics/steps'
  message: string  // human words, never a key
}

export interface DashboardData {
  generatedAt: string       // ISO, when the server fetched from Instantly
  range: DateRange
  configured: boolean       // false => INSTANTLY_API_KEY missing; everything else empty
  totals: { counts: Counts; rates: Rates }
  previous: { counts: Counts; rates: Rates } | null // same-length prior period, for deltas
  daily: DailyPoint[]
  campaigns: CampaignRow[]
  accounts: SenderAccount[]
  repliedLeads: RepliedLead[]
  insights: Insight[]
  errors: SourceError[]     // partial failures; UI shows them, never hides them
}
