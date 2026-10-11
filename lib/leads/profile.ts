/**
 * The full lead profile (plan 2.10): everything lib/leads/detail.ts already
 * reads, plus milestones, a reachability strip, segment/list membership, this
 * lead's campaigns, its score (when P2-F's lp.scores exists), its attached
 * files (lp.files, migration 0034) and an engagement-vs-campaign-average
 * benchmark -- all from stored rows, nothing invented.
 *
 * Every optional table (lp.segments/segment_members, lp.scores, lp.files) is
 * read defensively: on a preview DB that hasn't run the migration yet, the
 * section comes back with available:false and a "Needs migration NNNN" note
 * instead of throwing (lib/setup/db-status.ts's pattern). The UI (app/leads/
 * [id]/page.tsx) decides how to render that.
 */
import type { Queryable } from '../db/types'
import { getLeadDetail, type LeadDetail } from './detail'
import { listLeadFiles, isMissingTable, type LeadFileRow } from './files'
import { checkEmails } from '../suppressions/store'

export interface Milestones {
  first_touch: string | null
  first_open: string | null
  first_reply: string | null
  last_activity: string | null
}

export interface ReachabilityItem {
  key: 'verified_email' | 'store_phone' | 'owner_phone' | 'linkedin'
  label: string
  value: string | null
  ok: boolean
}

export interface SegmentMembership {
  id: number
  name: string
  kind: 'dynamic' | 'static'
  campaign_id: number | null
}

export interface SegmentsSection {
  available: boolean
  needs_migration: string | null
  memberships: SegmentMembership[]
}

export interface CampaignMembership {
  campaign_id: number
  campaign_name: string
  status: string
  added_at: string
}

export interface CampaignsSection {
  available: boolean
  needs_migration: string | null
  memberships: CampaignMembership[]
}

export interface FilesSection {
  available: boolean
  needs_migration: string | null
  rows: LeadFileRow[]
}

export interface ScoreSection {
  available: boolean
  needs_migration: string | null
  /** The company-level lp.scores row of the header's model (see loadScore), or null when not scored. */
  row: Record<string, unknown> | null
  /** Which model `row` is from, so the header can say what the number means. */
  model?: { id: number; name: string; kind: 'engagement' | 'fit'; campaign_id: number | null } | null
}

export interface EngagementCounts { opens: number; replies: number; steps: number }
export interface EngagementBenchmark {
  campaign_id: number
  campaign_name: string
  lead: EngagementCounts
  campaign_average: EngagementCounts
}

export interface EngagementSection {
  available: boolean
  benchmarks: EngagementBenchmark[]
}

export interface SuppressionSection {
  checked: boolean
  suppressed: boolean
  reason: string | null
  /** No contact on this lead has an email address: neither "Sendable" nor "Suppressed" (review fix, #79). */
  no_email?: boolean
}

export interface LeadProfile {
  detail: LeadDetail
  milestones: Milestones
  reachability: ReachabilityItem[]
  segments: SegmentsSection
  campaigns: CampaignsSection
  files: FilesSection
  score: ScoreSection
  suppression: SuppressionSection
  engagement: EngagementSection
  /** Plan 2.10 asks for these as honest placeholders until 3.x/4.x land -- never fake numbers. */
  placeholders: { journeys: string; deals: string; conversions: string }
}

function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
}

function earliest(dates: (string | null)[]): string | null {
  const vals = dates.filter((d): d is string => Boolean(d)).sort()
  return vals[0] ?? null
}
function latest(dates: (string | null)[]): string | null {
  const vals = dates.filter((d): d is string => Boolean(d)).sort()
  return vals.length ? vals[vals.length - 1] : null
}

/** Milestones over the lead's WHOLE history, in SQL (review fix, #79: they were taken from the
 *  newest 200 events/touches only, so a busy lead's first touch/open/reply was wrong). */
async function loadMilestones(q: Queryable, companyId: number, detail: LeadDetail): Promise<Milestones> {
  try {
    const { rows } = await q.query<{ first_touch: Date | string | null; first_open: Date | string | null; first_reply: Date | string | null; last_activity: Date | string | null }>(
      `with x as (
         select occurred_at as at, type from lp.lead_events where company_id = $1
         union all
         select occurred_at as at, event_type as type from lp.campaign_touches where company_id = $1
       )
       select min(at) as first_touch,
              min(at) filter (where type = 'email_opened') as first_open,
              min(at) filter (where type = 'reply_received') as first_reply,
              max(at) as last_activity
         from x`,
      [companyId],
    )
    const r = rows[0]
    return { first_touch: toIso(r?.first_touch), first_open: toIso(r?.first_open), first_reply: toIso(r?.first_reply), last_activity: toIso(r?.last_activity) }
  } catch (e) {
    if (isMissingTable(e)) return computeMilestones(detail)
    throw e
  }
}

function computeMilestones(detail: LeadDetail): Milestones {
  // Deliberately events + touches only, not lp.status_history / comments: a fresh
  // company row always gets a trigger-written "stage set to new" history row at
  // creation, which would make "last activity" read as "just now" for every brand
  // new lead with zero real engagement. These four milestones are about the
  // lead's own engagement (lp.lead_events / lp.campaign_touches), consistently.
  const eventTimes = detail.events.map((e) => ({ at: toIso(e.occurred_at), type: e.type }))
  const touchTimes = detail.touches.map((t) => ({ at: toIso(t.occurred_at), type: t.event_type }))
  const all = [...eventTimes, ...touchTimes]
  const opens = all.filter((x) => x.type === 'email_opened').map((x) => x.at)
  const replies = all.filter((x) => x.type === 'reply_received').map((x) => x.at)
  return {
    first_touch: earliest(all.map((x) => x.at)),
    first_open: earliest(opens),
    first_reply: earliest(replies),
    last_activity: latest(all.map((x) => x.at)),
  }
}

function computeReachability(detail: LeadDetail): ReachabilityItem[] {
  const verified = detail.contacts.find((c) => c.verification_status === 'valid')
  const direct = detail.contacts.find((c) => c.phone_e164 && !c.is_role_address) ?? detail.contacts.find((c) => c.phone_e164)
  const linkedin = detail.enrichment.find((e) => /linkedin/i.test(e.field))
  return [
    { key: 'verified_email', label: 'Verified email', value: verified?.email ?? null, ok: Boolean(verified) },
    { key: 'store_phone', label: 'Store phone', value: detail.company.phone ?? detail.company.phone_e164 ?? null, ok: Boolean(detail.company.phone || detail.company.phone_e164) },
    { key: 'owner_phone', label: 'Owner phone', value: direct?.phone_e164 ?? direct?.phone ?? null, ok: Boolean(direct) },
    { key: 'linkedin', label: 'LinkedIn', value: linkedin?.value ?? null, ok: Boolean(linkedin) },
  ]
}

const NEEDS = (n: string) => `Needs migration ${n} — it runs on the next production deploy.`

async function loadSegments(q: Queryable, companyId: number): Promise<SegmentsSection> {
  try {
    const { rows: segs } = await q.query<{ id: number; name: string; kind: 'dynamic' | 'static'; campaign_id: number | null; entity: string; definition: unknown }>(
      `select id, name, kind, campaign_id, entity, definition from lp.segments where archived_at is null and entity = 'company' order by name`,
    )
    const memberships: SegmentMembership[] = []
    for (const seg of segs) {
      if (seg.kind === 'static') {
        const { rows } = await q.query(`select 1 from lp.segment_members where segment_id = $1 and company_id = $2`, [seg.id, companyId])
        if (rows.length) memberships.push({ id: seg.id, name: seg.name, kind: 'static', campaign_id: seg.campaign_id })
      } else {
        try {
          // Lazy import keeps this module loadable even if lib/segments isn't present yet in some build.
          const { compileSegment, matchQuerySql } = await import('../segments/compile.ts')
          const compiled = await compileSegment(q, seg.definition)
          const base = matchQuerySql(compiled)
          const params = [...compiled.params, companyId]
          const { rows } = await q.query(`select 1 from (${base}) m where m.id = $${params.length} limit 1`, params)
          if (rows.length) memberships.push({ id: seg.id, name: seg.name, kind: 'dynamic', campaign_id: seg.campaign_id })
        } catch {
          // A broken/legacy definition on one segment shouldn't take the whole card down.
        }
      }
    }
    return { available: true, needs_migration: null, memberships }
  } catch (e) {
    if (isMissingTable(e)) return { available: false, needs_migration: NEEDS('0024'), memberships: [] }
    throw e
  }
}

async function loadCampaigns(q: Queryable, companyId: number): Promise<CampaignsSection> {
  try {
    const { rows } = await q.query<CampaignMembership>(
      `select cl.campaign_id, c.name as campaign_name, c.status, cl.added_at::text as added_at
         from lp.campaign_leads cl join lp.campaigns c on c.id = cl.campaign_id
        where cl.company_id = $1 order by cl.added_at desc`,
      [companyId],
    )
    return { available: true, needs_migration: null, memberships: rows }
  } catch (e) {
    if (isMissingTable(e)) return { available: false, needs_migration: NEEDS('0011'), memberships: [] }
    throw e
  }
}

async function loadScore(q: Queryable, companyId: number): Promise<ScoreSection> {
  try {
    // One fixed model, not "whichever lp.scores row changed last" (review fix, #79: that
    // mixed engagement, fit and per-campaign models, and contact rows that also carry a
    // company_id, so the header number changed meaning between visits). The header shows
    // the workspace-default company Engagement model; only if that model is gone or
    // inactive does it fall back, in a fixed order, to another active company model.
    // A lead that model never scored reads "Not scored yet" (NULL), never a made-up 0.
    const { rows: models } = await q.query<{ id: number; name: string; kind: 'engagement' | 'fit'; campaign_id: number | null }>(
      `select id, name, kind, campaign_id from lp.score_models
        where active and entity = 'company'
        order by (kind = 'engagement') desc, (campaign_id is null) desc, id
        limit 1`,
    )
    const model = models[0] ?? null
    if (!model) return { available: true, needs_migration: null, row: null, model: null }
    const { rows } = await q.query<Record<string, unknown>>(
      `select * from lp.scores where model_id = $1 and company_id = $2 and contact_id is null limit 1`,
      [model.id, companyId],
    )
    return { available: true, needs_migration: null, row: rows[0] ?? null, model: { ...model, id: Number(model.id) } }
  } catch (e) {
    if (isMissingTable(e)) return { available: false, needs_migration: 'Needs lead scoring (plan 2.8) — not merged on this deploy yet.', row: null }
    throw e
  }
}

async function loadEngagement(q: Queryable, companyId: number): Promise<EngagementSection> {
  try {
    const { rows: campaignIds } = await q.query<{ campaign_id: number }>(
      `select distinct campaign_id from lp.lead_events where company_id = $1 and campaign_id is not null`,
      [companyId],
    )
    if (!campaignIds.length) return { available: true, benchmarks: [] }
    const benchmarks: EngagementBenchmark[] = []
    for (const { campaign_id } of campaignIds) {
      const { rows: campRows } = await q.query<{ name: string }>(`select name from lp.campaigns where id = $1`, [campaign_id])
      const campaignName = campRows[0]?.name ?? `Campaign ${campaign_id}`
      const countFor = async (companyFilter: string, params: unknown[]) => {
        const { rows } = await q.query<{ opens: string; replies: string; steps: string; leads: string }>(
          `select
             count(*) filter (where type = 'email_opened')::int as opens,
             count(*) filter (where type = 'reply_received')::int as replies,
             count(*) filter (where type = 'email_sent')::int as steps,
             count(distinct company_id)::int as leads
           from lp.lead_events where campaign_id = $1 ${companyFilter}`,
          params,
        )
        return rows[0]
      }
      const lead = await countFor('and company_id = $2', [campaign_id, companyId])
      const campaignTotals = await countFor('', [campaign_id])
      const leads = Math.max(Number(campaignTotals?.leads ?? 0), 1)
      benchmarks.push({
        campaign_id,
        campaign_name: campaignName,
        lead: { opens: Number(lead?.opens ?? 0), replies: Number(lead?.replies ?? 0), steps: Number(lead?.steps ?? 0) },
        campaign_average: {
          opens: Math.round((Number(campaignTotals?.opens ?? 0) / leads) * 10) / 10,
          replies: Math.round((Number(campaignTotals?.replies ?? 0) / leads) * 10) / 10,
          steps: Math.round((Number(campaignTotals?.steps ?? 0) / leads) * 10) / 10,
        },
      })
    }
    return { available: true, benchmarks }
  } catch (e) {
    if (isMissingTable(e)) return { available: false, benchmarks: [] }
    throw e
  }
}

async function loadFiles(q: Queryable, companyId: number): Promise<FilesSection> {
  try {
    // Probe existence directly: listLeadFiles (lib/leads/files.ts) deliberately
    // swallows a missing-table error itself (so callers who just want "the list,
    // or nothing" don't need to know about migrations) -- that would hide the
    // error from this needs_migration check, so check the table first.
    await q.query('select 1 from lp.files limit 1')
  } catch (e) {
    if (isMissingTable(e)) return { available: false, needs_migration: NEEDS('0034'), rows: [] }
    throw e
  }
  return { available: true, needs_migration: null, rows: await listLeadFiles(q, companyId) }
}


async function loadSuppression(q: Queryable, detail: LeadDetail): Promise<SuppressionSection> {
  // Review fix (#79): "Sendable" only when some contact can actually be emailed.
  const withEmail = detail.contacts.filter((c) => Boolean(c.email))
  if (!withEmail.length) return { checked: true, suppressed: false, reason: null, no_email: true }
  const emails = withEmail.filter((c) => !c.do_not_contact && c.verification_status !== 'invalid').map((c) => c.email as string)
  if (!emails.length) return { checked: true, suppressed: true, reason: 'No contact can be emailed (do not contact, or the email is invalid).' }
  try {
    const checks = await checkEmails(q, emails)
    const hit = Object.values(checks).find((c) => c.suppressed)
    return { checked: true, suppressed: Boolean(hit), reason: hit?.by?.reason ?? null }
  } catch (e) {
    if (isMissingTable(e)) return { checked: false, suppressed: false, reason: null }
    throw e
  }
}

export async function getLeadProfile(q: Queryable, companyId: number): Promise<LeadProfile | null> {
  const detail = await getLeadDetail(q, companyId)
  if (!detail) return null
  const [segments, campaigns, score, engagement, files, suppression, milestones] = await Promise.all([
    loadSegments(q, companyId),
    loadCampaigns(q, companyId),
    loadScore(q, companyId),
    loadEngagement(q, companyId),
    loadFiles(q, companyId),
    loadSuppression(q, detail),
    loadMilestones(q, companyId, detail),
  ])
  return {
    detail,
    milestones,
    reachability: computeReachability(detail),
    segments,
    campaigns,
    files,
    score,
    suppression,
    engagement,
    placeholders: { journeys: 'Not built yet', deals: 'Not built yet', conversions: 'Not built yet' },
  }
}
