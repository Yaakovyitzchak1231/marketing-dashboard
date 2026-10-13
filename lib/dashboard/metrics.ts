/**
 * Pure metric math: Instantly v2 responses -> the dashboard contract.
 *
 * Field meanings (OpenAPI spec https://api.instantly.ai/openapi/api_v2.json,
 * confirmed live 2026-10-08):
 *   sent          = emails_sent_count            every email sent, all steps
 *   contacted     = new_leads_contacted_count    distinct leads whose step 1 went out in the range.
 *                   (contacted_count is NOT used: live it equals emails_sent_count, i.e. it counts sends)
 *   replied       = reply_count_unique           first reply per lead; docs: "Excludes automatic replies".
 *                   Automatic replies are reported separately and are NOT subtracted (live: in 30d
 *                   unique replies 10 vs unique automatic 11 — auto is not a subset).
 *   autoReplies   = reply_count_automatic_unique
 *   opened        = open_count_unique            only when open tracking is ON, else null
 *   clicked       = link_click_count_unique      only when link tracking is ON, else null
 *   bounced       = bounced_count                bounced leads
 *   unsubscribed  = unsubscribed_count
 *   positive      = total_opportunities          unique leads marked as an opportunity (positive interest) in Instantly
 *   meetingsBooked= total_meeting_booked         overview endpoint only
 *   opportunityValue = total_opportunity_value   Instantly's configured value per opportunity x count
 *
 * Rates (0..1), each null when the denominator is null or 0:
 *   replyRate = replied / contacted, positiveRate = positive / contacted,
 *   positiveShareOfReplies = positive / replied, bounceRate = bounced / sent,
 *   openRate = opened / contacted, clickRate = clicked / contacted,
 *   unsubscribeRate = unsubscribed / contacted.
 * A per-person rate whose numerator exceeds its denominator is returned as
 * null (it cannot be a real rate). That happens on short ranges when replies
 * arrive from leads first contacted before the range; the loader explains it.
 */
import type { Counts, DailyPoint, Rates, RepliedLead, StepStat } from '@/lib/dashboard/types'
import type {
  ApiAccountDailyRow, ApiAnalyticsCounts, ApiAnalyticsOverview, ApiCampaign, ApiDailyRow, ApiEmail, ApiLead, ApiStepRow,
} from '@/lib/instantly/types'
import { dateInZone, eachDay } from '@/lib/dashboard/dates'

export const EMPTY_COUNTS: Counts = Object.freeze({
  sent: null, contacted: null, opened: null, clicked: null, replied: null, autoReplies: null,
  bounced: null, unsubscribed: null, positive: null, meetingsBooked: null, opportunityValue: null,
}) as Counts

export const ZERO_COUNTS_FOR_RANGE: Omit<Counts, 'opened' | 'clicked'> = Object.freeze({
  sent: 0, contacted: 0, replied: 0, autoReplies: 0, bounced: 0, unsubscribed: 0,
  positive: 0, meetingsBooked: 0, opportunityValue: 0,
})

/** A finite number, or null. Numeric strings are accepted; nothing else is coerced. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** n / d, or null when either is unknown or d is 0. */
export function ratio(n: number | null, d: number | null): number | null {
  if (n === null || d === null || d === 0) return null
  return n / d
}

/** Same as ratio, but a "share of people" above 100% is impossible, so it is null. */
function share(n: number | null, d: number | null): number | null {
  const r = ratio(n, d)
  return r !== null && r > 1 ? null : r
}

export interface Tracking {
  /** true = on, false = off, null = unknown */
  open: boolean | null
  link: boolean | null
}

/** Maps one analytics object (overview or per-campaign row) to Counts. */
export function countsFromApi(raw: ApiAnalyticsCounts | ApiAnalyticsOverview | null | undefined, tracking: Tracking): Counts {
  if (!raw) return { ...EMPTY_COUNTS }
  const o = raw as ApiAnalyticsOverview
  return {
    sent: num(raw.emails_sent_count),
    contacted: num(raw.new_leads_contacted_count),
    opened: tracking.open === true ? num(raw.open_count_unique) : null,
    clicked: tracking.link === true ? num(raw.link_click_count_unique) : null,
    replied: num(raw.reply_count_unique),
    autoReplies: num(raw.reply_count_automatic_unique),
    bounced: num(raw.bounced_count),
    unsubscribed: num(raw.unsubscribed_count),
    positive: num(raw.total_opportunities),
    meetingsBooked: 'total_meeting_booked' in o ? num(o.total_meeting_booked) : null,
    opportunityValue: num(raw.total_opportunity_value),
  }
}

export function ratesFrom(c: Counts): Rates {
  return {
    replyRate: share(c.replied, c.contacted),
    positiveRate: share(c.positive, c.contacted),
    positiveShareOfReplies: share(c.positive, c.replied),
    bounceRate: share(c.bounced, c.sent),
    openRate: share(c.opened, c.contacted),
    clickRate: share(c.clicked, c.contacted),
    unsubscribeRate: share(c.unsubscribed, c.contacted),
  }
}

/** Counts for a campaign that the range analytics call omitted: a measured zero, except tracking-gated fields. */
export function zeroCounts(tracking: Tracking): Counts {
  return {
    ...ZERO_COUNTS_FOR_RANGE,
    // Per-campaign analytics carry no meetings field; that comes from the overview.
    meetingsBooked: null,
    opened: tracking.open === true ? 0 : null,
    clicked: tracking.link === true ? 0 : null,
  }
}

/**
 * Workspace-level tracking: on only if EVERY campaign that sent in the range has it on.
 * Mixed or unknown -> null, so a blended open rate never mixes tracked and untracked sends.
 */
export function combinedTracking(flags: Array<boolean | null>): boolean | null {
  if (flags.length === 0) return null
  if (flags.every((f) => f === true)) return true
  if (flags.every((f) => f === false)) return false
  return null
}

/**
 * Open tracking is "off" for the workspace when at least one campaign reports it
 * and every campaign that reports it says off. Unknown flags are ignored, so an
 * unreported campaign never flips the answer either way. Used for the
 * "tracking off" label instead of a 0% open rate.
 */
export function openTrackingOff(flags: Array<boolean | null>): boolean {
  const known = flags.filter((f) => f !== null)
  return known.length > 0 && known.every((f) => f === false)
}

/** Maps Instantly's numeric campaign status to the contract's words. */
export function campaignStatus(code: unknown): 'draft' | 'active' | 'paused' | 'completed' | 'error' | 'unknown' {
  switch (num(code)) {
    case 0: return 'draft'
    case 1: return 'active'
    case 2: return 'paused'
    case 3: return 'completed'
    case 4: return 'active' // running subsequences: still sending
    case -99: case -1: case -2: return 'error' // suspended / accounts unhealthy / bounce protect
    default: return 'unknown'
  }
}

/** Instantly's own words for an account status code. */
export function accountStatusWord(code: unknown): string {
  switch (num(code)) {
    case 1: return 'active'
    case 2: return 'paused'
    case 3: return 'maintenance'
    case -1: return 'connection error'
    case -2: return 'soft bounce error'
    case -3: return 'sending error'
    default: return code === undefined || code === null ? 'unknown' : `status ${String(code)}`
  }
}

/**
 * Daily series over [start, end]. The API omits days with no activity, so a
 * day missing from a successful response is a measured 0. When the call
 * failed, pass rows = null and every value is null.
 * Bounces are not in the daily endpoint: always null.
 */
export function dailySeries(
  rows: ApiDailyRow[] | null, start: string, end: string, tracking: { open: boolean | null },
): DailyPoint[] {
  const byDate = new Map<string, ApiDailyRow>()
  for (const r of rows ?? []) if (r && typeof r.date === 'string') byDate.set(r.date.slice(0, 10), r)
  return eachDay(start, end).map((date) => {
    if (rows === null) return { date, sent: null, contacted: null, replied: null, positive: null, bounced: null, opened: null }
    const r = byDate.get(date)
    const v = (x: unknown) => (r ? num(x) : 0)
    return {
      date,
      sent: v(r?.sent),
      contacted: v(r?.new_leads_contacted),
      replied: v(r?.unique_replies),
      positive: v(r?.unique_opportunities),
      bounced: null,
      opened: tracking.open === true ? v(r?.unique_opened) : null,
    }
  })
}

const VARIANT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function variantLetter(index: number): string {
  return index >= 0 && index < VARIANT_LETTERS.length ? VARIANT_LETTERS[index] : `V${index + 1}`
}

/** A non-negative integer from a 0-based step/variant string, or null ("null", null, garbage). */
function index0(v: unknown): number | null {
  const n = num(v)
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * Per step+variant stats. Instantly's `step` and `variant` are 0-based strings
 * ("0" = step 1, "1" = variant B); rows with an undetermined step/variant are
 * dropped (their replies still count in the campaign totals). Subjects come
 * from the campaign's sequences[0].steps[i].variants[j].subject.
 * replyRate = unique replies / sent for that step+variant.
 */
export function stepStats(rows: ApiStepRow[], campaign: ApiCampaign | undefined, openTracking: boolean | null): StepStat[] {
  const steps = campaign?.sequences?.[0]?.steps ?? []
  const out: StepStat[] = []
  for (const r of rows) {
    const s = index0(r.step)
    const v = index0(r.variant)
    if (s === null || v === null) continue
    const subject = steps[s]?.variants?.[v]?.subject
    const sent = num(r.sent)
    const replied = num(r.unique_replies)
    out.push({
      step: s + 1,
      variant: variantLetter(v),
      subject: typeof subject === 'string' && subject.trim() ? subject : null,
      sent,
      opened: openTracking === true ? num(r.unique_opened) : null,
      replied,
      positive: 'unique_opportunities' in r ? num(r.unique_opportunities) : null,
      replyRate: share(replied, sent),
    })
  }
  return out.sort((a, b) => a.step - b.step || a.variant.localeCompare(b.variant))
}

export interface AccountTotals {
  sent: number
  bounced: number
  replied: number
}

/** Sums /accounts/analytics/daily rows per sending account (lower-cased email). */
export function sumAccountDaily(rows: ApiAccountDailyRow[]): Map<string, AccountTotals> {
  const out = new Map<string, AccountTotals>()
  for (const r of rows) {
    if (!r?.email_account) continue
    const k = r.email_account.toLowerCase()
    const t = out.get(k) ?? { sent: 0, bounced: 0, replied: 0 }
    t.sent += num(r.sent) ?? 0
    t.bounced += num(r.bounced) ?? 0
    t.replied += num(r.unique_replies) ?? 0
    out.set(k, t)
  }
  return out
}

/** Sums Counts field by field; a field is null if it is null in any input. */
export function sumCounts(list: Counts[]): Counts {
  if (list.length === 0) return { ...EMPTY_COUNTS }
  const keys = Object.keys(EMPTY_COUNTS) as Array<keyof Counts>
  const out = { ...EMPTY_COUNTS }
  for (const k of keys) {
    let total: number | null = 0
    for (const c of list) {
      const v = c[k]
      if (v === null || total === null) { total = null; break }
      total += v
    }
    out[k] = total
  }
  return out
}

/** Instantly lt_interest_status -> contract interest. No Show is -4; custom labels are 'unlabeled'. */
export function interestFrom(code: unknown): RepliedLead['interest'] {
  switch (num(code)) {
    case 0: return 'out_of_office'
    case 1: return 'interested'
    case 2: return 'meeting_booked'
    case 3: return 'meeting_completed'
    case 4: return 'won'
    case -1: return 'not_interested'
    case -2: return 'wrong_person'
    case -3: return 'lost'
    case -4: return 'no_show'
    default: return 'unlabeled'
  }
}

export interface RepliedLeadsInput {
  /** Latest email of each thread that has a received email (GET /emails latest_of_thread). Newest first. */
  threads: ApiEmail[]
  /** Lead records for those threads' contacts (POST /leads/list contacts filter). */
  leads: ApiLead[]
  campaignNames: Map<string, string>
  /** Inclusive range in `timeZone`; start null = all time. */
  start: string | null
  end: string
  timeZone: string
  now: Date
  limit?: number
}

/**
 * Leads who replied in the range, newest reply first, at most `limit`.
 * - Only leads Instantly recorded a reply for (timestamp_last_reply set or email_reply_count > 0);
 *   bounce notices and mail from non-leads drop out here.
 * - lastReplyAt = the lead's timestamp_last_reply.
 * - awaitingOurReply = the latest email in the lead's thread is one we RECEIVED (ue_type 2),
 *   i.e. nobody has written back since their message.
 * - daysWaiting = whole days since lastReplyAt, only while awaiting.
 * - lastReplySnippet = the preview of that received email (null when we wrote last).
 */
export function repliedLeadsFrom(input: RepliedLeadsInput): RepliedLead[] {
  const limit = input.limit ?? 50
  const latestByLead = new Map<string, ApiEmail>()
  for (const e of input.threads) {
    const k = e.lead?.toLowerCase()
    if (!k) continue
    const prev = latestByLead.get(k)
    const t = Date.parse(e.timestamp_email ?? e.timestamp_created ?? '')
    const pt = prev ? Date.parse(prev.timestamp_email ?? prev.timestamp_created ?? '') : -Infinity
    if (!prev || (Number.isFinite(t) && t > pt)) latestByLead.set(k, e)
  }
  const leadsByEmail = new Map<string, ApiLead[]>()
  for (const l of input.leads) {
    const k = l.email?.toLowerCase()
    if (!k) continue
    leadsByEmail.set(k, [...(leadsByEmail.get(k) ?? []), l])
  }
  const out: Array<RepliedLead & { _t: number }> = []
  for (const [email, latest] of latestByLead) {
    const candidates = (leadsByEmail.get(email) ?? []).filter(
      (l) => !!l.timestamp_last_reply || (num(l.email_reply_count) ?? 0) > 0,
    )
    if (candidates.length === 0) continue
    let bestLead = candidates[0]
    let maxTime = -Infinity
    for (const c of candidates) {
      if (latest.campaign_id && c.campaign === latest.campaign_id) {
        bestLead = c
        break
      }
      const t = Date.parse(c.timestamp_last_reply ?? '')
      // A lead with no usable reply time never beats one that has it; with none, the first stays.
      if (Number.isFinite(t) && t > maxTime) {
        maxTime = t
        bestLead = c
      }
    }
    const lead = bestLead
    const lastReplyAt = lead.timestamp_last_reply ?? (latest.ue_type === 2 ? latest.timestamp_email ?? null : null)
    const t = lastReplyAt ? Date.parse(lastReplyAt) : NaN
    if (!Number.isFinite(t)) continue
    const day = dateInZone(new Date(t), input.timeZone)
    if ((input.start !== null && day < input.start) || day > input.end) continue
    const awaiting = latest.ue_type === 2
    const name = [lead.first_name, lead.last_name].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim()
    const campaignId = lead.campaign ?? latest.campaign_id ?? null
    out.push({
      email: lead.email ?? email,
      name: name || null,
      company: lead.company_name?.trim() || null,
      campaignId,
      campaignName: campaignId ? input.campaignNames.get(campaignId) ?? null : null,
      interest: interestFrom(lead.lt_interest_status),
      lastReplyAt: new Date(t).toISOString(),
      lastReplySnippet: awaiting ? latest.content_preview?.trim() || null : null,
      awaitingOurReply: awaiting,
      daysWaiting: awaiting ? Math.max(0, Math.floor((input.now.getTime() - t) / 86_400_000)) : null,
      _t: t,
    })
  }
  return out
    .sort((a, b) => b._t - a._t)
    .slice(0, limit)
    .map(({ _t, ...rest }) => rest)
}
