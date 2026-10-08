/**
 * Lead runway: how many leads are left to email, and how many days that lasts
 * at the pace Instantly is actually contacting new leads.
 *
 * Sources, and nothing else:
 *  - Per campaign (Instantly): leads loaded but not yet contacted
 *    (CampaignRow.leadsRemaining) and new leads contacted in the last 7 days
 *    (counts.contacted for the 7-day range). Pace = that / 7 calendar days.
 *  - Per segment (lead database): verified, never-contacted leads not yet in
 *    any campaign, plus the unverified ones that could be verified next.
 * A missing figure stays null and the screen says "no data"; it is never 0.
 */
import type { Queryable } from '@/lib/db/types'
import type { CampaignRow, CampaignStatus } from '@/lib/dashboard/types'
import type { CampaignMeta, Segment } from '@/lib/reports/meta'
import { SEGMENTS } from '@/lib/reports/meta'

/** Under this many days of leads, the screen warns. */
export const RUNWAY_WARN_DAYS = 14
/** The pace window: calendar days of Instantly history behind "per day". */
export const PACE_DAYS = 7

export type RunwayLevel = 'ok' | 'low' | 'out' | 'not_sending' | 'no_data'

export interface CampaignRunway {
  id: string
  name: string
  status: CampaignStatus
  segment: Segment | null
  angle: string | null
  /** Loaded in Instantly, not yet contacted. */
  remaining: number | null
  contactedInWindow: number | null
  pacePerDay: number | null
  days: number | null
  level: RunwayLevel
}

export interface SegmentPool {
  segment: Segment
  /** Verified valid, never contacted, in no campaign. */
  ready: number
  /** Never contacted, email not verified yet. */
  unverified: number
}

export interface SegmentRunway extends SegmentPool {
  campaigns: number
  /** Sum of loaded-not-contacted across this segment's campaigns; null if any campaign did not report it. */
  loadedRemaining: number | null
  pacePerDay: number | null
  days: number | null
  level: RunwayLevel
}

export function levelFor(left: number | null, pace: number | null): RunwayLevel {
  if (left === null || pace === null) return 'no_data'
  if (pace <= 0) return 'not_sending'
  if (left <= 0) return 'out'
  return left / pace < RUNWAY_WARN_DAYS ? 'low' : 'ok'
}

export function campaignRunway(c: CampaignRow, meta: CampaignMeta | undefined, windowDays = PACE_DAYS): CampaignRunway {
  const contacted = c.counts.contacted
  const pace = contacted === null ? null : contacted / windowDays
  const remaining = c.leadsRemaining
  const sending = c.status === 'active'
  const days = sending && remaining !== null && pace !== null && pace > 0 ? remaining / pace : null
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    segment: meta?.segment ?? null,
    angle: meta?.angle ?? null,
    remaining,
    contactedInWindow: contacted,
    pacePerDay: pace,
    days,
    level: sending ? levelFor(remaining, pace) : 'not_sending',
  }
}

export function segmentRunway(pools: SegmentPool[], campaigns: CampaignRunway[]): SegmentRunway[] {
  return SEGMENTS.map((segment) => {
    const pool = pools.find((p) => p.segment === segment) ?? { segment, ready: 0, unverified: 0 }
    const mine = campaigns.filter((c) => c.segment === segment)
    const loaded = mine.length === 0 ? 0 : mine.some((c) => c.remaining === null) ? null : mine.reduce((s, c) => s + (c.remaining as number), 0)
    // Only campaigns that are sending right now set the pace.
    const live = mine.filter((c) => c.status === 'active')
    const pace = live.length === 0 ? (mine.length ? 0 : null) : live.some((c) => c.pacePerDay === null) ? null : live.reduce((s, c) => s + (c.pacePerDay as number), 0)
    const left = loaded === null ? null : pool.ready + loaded
    const days = left !== null && pace !== null && pace > 0 ? left / pace : null
    return { ...pool, campaigns: mine.length, loadedRemaining: loaded, pacePerDay: pace, days, level: levelFor(left, pace) }
  }).filter((s) => s.campaigns > 0 || s.ready > 0 || s.unverified > 0)
}

/**
 * Never-contacted leads per segment, from the lead database. "Never contacted"
 * = no campaign touch of any kind, contact status still new/verifying/valid-ready,
 * company not yet in a campaign stage, not do-not-contact.
 */
export async function segmentPools(q: Queryable): Promise<SegmentPool[]> {
  const { rows } = await q.query<{ segment: Segment; ready: number; unverified: number }>(
    `select co.segment,
            count(*) filter (where ct.verification_status = 'valid')::int      as ready,
            count(*) filter (where ct.verification_status = 'unverified')::int as unverified
       from lp.contacts ct
       join lp.companies co on co.id = ct.company_id
      where ct.email_norm is not null
        and not ct.do_not_contact
        and ct.status in ('new', 'verifying', 'valid-ready')
        and co.stage in ('new', 'researched', 'ready')
        and not exists (select 1 from lp.campaign_touches t where t.contact_id = ct.id)
      group by co.segment`,
  )
  return rows.map((r) => ({ segment: r.segment, ready: Number(r.ready), unverified: Number(r.unverified) }))
}

export function formatDays(days: number | null): string {
  if (days === null) return 'no data'
  if (days < 1) return 'under a day'
  return `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'}`
}

export const LEVEL_WORDS: Record<RunwayLevel, string> = {
  ok: 'OK',
  low: `Under ${RUNWAY_WARN_DAYS} days`,
  out: 'Out of leads',
  not_sending: 'Not sending',
  no_data: 'No data',
}
