/**
 * Advanced filters on the Leads screen (plan 2.5): turn ?seg=<id> or
 * ?f=<encoded definition> (lib/leads/filters.ts) into the exact company ids
 * to narrow the list to (lib/leads/queries.ts's buildLeadWhere reads
 * filters.companyIds). Both are optional and mutually exclusive in the UI
 * (the drawer writes one or the other); if a page somehow carries both, the
 * saved segment (?seg=) wins.
 */
import type { Queryable } from '../db/types'
import type { SegmentDefinition } from '../segments/definition'
import { getSegment } from '../segments/store'
import { companyIdsForDefinition } from '../segments/match-companies'

export interface AdvancedFilter {
  /** What narrowed the list: a saved segment's id and name, or an ad-hoc definition. */
  source: { kind: 'segment'; id: number; name: string } | { kind: 'ad_hoc' } | null
  /** Company ids to intersect with every other Leads filter, or null (nothing active / the table isn't migrated yet). */
  companyIds: number[] | null
}

function tableMissing(e: unknown): boolean {
  return /does not exist/i.test((e as Error)?.message ?? '')
}

export async function resolveAdvancedFilter(db: Queryable, segId: number | null, def: SegmentDefinition | null): Promise<AdvancedFilter> {
  if (!segId && !def) return { source: null, companyIds: null }
  try {
    if (segId) {
      const seg = await getSegment(db, segId)
      // A stale/removed segment id must not fall back to "no restriction" (that
      // would silently show the whole table under a URL that says "filtered").
      if (!seg) return { source: null, companyIds: [] }
      const companyIds = await companyIdsForDefinition(db, seg.definition)
      return { source: { kind: 'segment', id: seg.id, name: seg.name }, companyIds }
    }
    const companyIds = await companyIdsForDefinition(db, def)
    return { source: { kind: 'ad_hoc' }, companyIds }
  } catch (e) {
    if (tableMissing(e)) return { source: null, companyIds: null }
    throw e
  }
}
