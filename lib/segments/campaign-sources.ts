/**
 * Segments as campaign sources and exclusions (plan 2.6), on top of the
 * segment engine (lib/segments/*, migration 0024) and the campaign lead list
 * (lib/campaigns/leads.ts). Migration: 0032_campaign_segment_sources.sql.
 *
 * campaign_add_from_segment pulls a segment's matching companies into a
 * campaign through the campaign's EXISTING add path (addLeadsByIds, same as
 * "add by hand" / the ops API) -- so the same audit log and lead events fire,
 * membership is still a normal lp.campaign_leads row, and the evaluator
 * (lib/campaigns/evaluator.ts) scores it exactly like any other lead the next
 * time the campaign page reads it. Before that insert, three checks narrow the
 * matched set, in this order:
 *   1. excluded      -- the company is in one of exclude_segment_ids (e.g. a
 *                        "customers" or "competitors" list); never added, no
 *                        matter what else matches.
 *   2. rule-rejected -- the company's own stage is 'do_not_contact'. This is
 *                        the one standing business rule this workspace already
 *                        has for "never put this lead in a campaign" (the
 *                        Leads screen's own stage list, lib/leads/types.ts);
 *                        it is not the rule-set/evaluator's Ready/Parked tier,
 *                        which only affects whether a lead UPLOADS to
 *                        Instantly, not whether it can be on a campaign's list.
 *   3. suppressed    -- the company's primary (first-added) contact email is
 *                        suppressed (lp.is_suppressed via checkEmails); a
 *                        company with no contact email at all is never
 *                        suppressed on that account and proceeds.
 * What's left goes through addLeadsByIds, which itself treats "already in the
 * campaign" as a no-op (on conflict do nothing) -- so calling this op again
 * (keep_syncing) only ever adds what's new.
 */
import type { Db, Queryable } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { logEvent } from '../ops/events.ts'
import { getCampaign } from '../campaigns/store.ts'
import { addLeadsByIds } from '../campaigns/leads.ts'
import { getSegment, type Segment } from './store.ts'
import { companyIdsForSegment, companyIdsInSegment } from './match-companies.ts'
import { checkEmails } from '../suppressions/store.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

/** Every segment matched by this op can be a large (whole-database) add; the same ceiling addLeadsByFilter uses. */
const MAX_SOURCE_ADD = 30_000

function posInt(v: unknown, field: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new OpsError(`${field} must be a positive integer`)
  return n
}

function idArray(v: unknown, field: string): number[] {
  if (v == null) return []
  if (!Array.isArray(v)) throw new OpsError(`${field} must be an array of segment ids`)
  return v.map((x) => posInt(x, field))
}

async function requireSegment(q: Queryable, id: number): Promise<Segment> {
  const seg = await getSegment(q, id)
  if (!seg) throw new OpsError(`No segment ${id}.`, 404)
  return seg
}

async function requireCampaign(q: Queryable, id: number) {
  const c = await getCampaign(q, id)
  if (!c) throw new OpsError(`No campaign ${id}.`, 404)
  return c
}

/** Every company id a segment matches, up to MAX_SOURCE_ADD + 1 (so an over-large segment is detected, not silently truncated). */
async function segmentCompanyIds(q: Queryable, seg: Segment): Promise<number[]> {
  return companyIdsForSegment(q, seg, MAX_SOURCE_ADD)
}

export interface SegmentSourceResult {
  campaign_id: number
  segment_id: number
  matching: number
  added: number
  already: number
  skipped_by_rule: number
  skipped_suppressed: number
  skipped_excluded: number
}

/**
 * Pulls a segment's matching companies into a campaign (persisting the source
 * segment / sync mode / exclude list onto the campaign itself, so re-reading
 * the campaign later shows where its leads came from, and so a later
 * "keep syncing" pass -- same op, same args -- only adds what's new).
 */
async function addFromSegment(db: Db, actor: string, a: Args): Promise<SegmentSourceResult> {
  const campaignId = posInt(a.campaign_id, 'campaign_id')
  const segmentId = posInt(a.segment_id, 'segment_id')
  const keepSyncing = a.keep_syncing === true || a.keep_syncing === 'true'
  const excludeIds = idArray(a.exclude_segment_ids, 'exclude_segment_ids')

  return db.tx(async (q) => {
    const campaign = await requireCampaign(q, campaignId)
    const seg = await requireSegment(q, segmentId)
    const excludeSegs = await Promise.all(excludeIds.map((id) => requireSegment(q, id)))

    const matching = await segmentCompanyIds(q, seg)
    if (matching.length > MAX_SOURCE_ADD) {
      throw new OpsError(`That segment matches more than ${MAX_SOURCE_ADD} leads; add from a narrower segment.`)
    }

    const excludedSet = new Set<number>()
    // Exclusions are decided in SQL against the candidate ids, with no row cap: an
    // excluded lead is never added, however large the exclusion segment is.
    for (const es of excludeSegs) {
      for (const id of await companyIdsInSegment(q, es, matching)) excludedSet.add(id)
    }

    const remaining1 = matching.filter((id) => !excludedSet.has(id))
    const skippedExcluded = matching.length - remaining1.length

    let ruleRejectedSet = new Set<number>()
    if (remaining1.length) {
      const { rows } = await q.query<{ id: string | number }>(
        `select id from lp.companies where id = any($1::bigint[]) and stage = 'do_not_contact'`,
        [remaining1],
      )
      ruleRejectedSet = new Set(rows.map((r) => Number(r.id)))
    }
    const remaining2 = remaining1.filter((id) => !ruleRejectedSet.has(id))
    const skippedByRule = remaining1.length - remaining2.length

    const suppressedSet = new Set<number>()
    if (remaining2.length) {
      // One primary (first-added) contact email per remaining company.
      const { rows } = await q.query<{ company_id: string | number; email: string }>(
        `select distinct on (ct.company_id) ct.company_id, ct.email
           from lp.contacts ct where ct.company_id = any($1::bigint[]) and ct.email is not null
           order by ct.company_id, ct.id`,
        [remaining2],
      )
      if (rows.length) {
        const checks = await checkEmails(q, rows.map((r) => r.email), campaignId)
        for (const r of rows) if (checks[r.email]?.suppressed) suppressedSet.add(Number(r.company_id))
      }
    }
    const remaining3 = remaining2.filter((id) => !suppressedSet.has(id))
    const skippedSuppressed = remaining2.length - remaining3.length

    const result = await addLeadsByIds({ tx: (fn) => fn(q) }, actor, campaignId, remaining3, 'api')

    await q.query(
      `update lp.campaigns set source_segment_id = $2, source_sync = $3, exclude_segment_ids = $4, updated_by = $5 where id = $1`,
      [campaignId, segmentId, keepSyncing ? 'keep_syncing' : 'once', excludeIds, actor],
    )
    await logEvent(q, {
      actor,
      kind: 'campaign.leads_added',
      summary: `${actor} added ${result.added} lead${result.added === 1 ? '' : 's'} to "${campaign.name}" from segment "${seg.name}"${excludeSegs.length ? `, excluding ${excludeSegs.map((s) => s.name).join(', ')}` : ''} (${keepSyncing ? 'keep syncing' : 'one time'})`,
      entity_type: 'campaign',
      entity_id: campaignId,
      data: {
        via: 'segment', segment_id: segmentId, exclude_segment_ids: excludeIds, keep_syncing: keepSyncing,
        matching: matching.length, added: result.added, already: result.already,
        skipped_by_rule: skippedByRule, skipped_suppressed: skippedSuppressed, skipped_excluded: skippedExcluded,
      },
    })

    return {
      campaign_id: campaignId,
      segment_id: segmentId,
      matching: matching.length,
      added: result.added,
      already: result.already,
      skipped_by_rule: skippedByRule,
      skipped_suppressed: skippedSuppressed,
      skipped_excluded: skippedExcluded,
    }
  }, actor)
}

export const CAMPAIGN_SOURCE_OPS: Record<string, Op> = {
  campaign_add_from_segment: {
    args: '{campaign_id, segment_id, keep_syncing?, exclude_segment_ids?: number[]}  -> adds the segment\'s matching companies (through the normal add-by-id path, so it passes the same rules + suppression check); persists source_segment_id/source_sync/exclude_segment_ids on the campaign',
    run: addFromSegment,
  },
}
