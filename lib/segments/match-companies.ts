/**
 * Resolve ANY segment (by its own entity) to plain company ids -- the one
 * place "I have a segment id / a definition, give me company ids" lives, so
 * campaign sources (lib/segments/campaign-sources.ts) and the Leads screen's
 * advanced filters (lib/leads/advanced.ts) share it instead of each
 * reimplementing the company/contact-entity split.
 */
import type { Queryable } from '../db/types.ts'
import { compileSegment, compileStoredSegment, matchQuerySql, type CompiledSegment, type StoredSegmentLike } from './compile.ts'
import type { SegmentDefinition } from './definition.ts'

async function idsFromCompiled(q: Queryable, compiled: CompiledSegment, limit: number | null): Promise<number[]> {
  const match = matchQuerySql(compiled)
  const limitSql = limit != null ? ` limit ${Math.floor(limit) + 1}` : ''
  if (compiled.entity === 'company') {
    const { rows } = await q.query<{ id: string | number }>(`${match}${limitSql}`, compiled.params)
    return rows.map((r) => Number(r.id))
  }
  const { rows } = await q.query<{ id: string | number }>(
    `select distinct ct.company_id as id from lp.contacts ct join (${match}) m on m.id = ct.id where ct.company_id is not null${limitSql}`,
    compiled.params,
  )
  return rows.map((r) => Number(r.id))
}

/**
 * Every company id a definition matches, regardless of its own entity
 * ('company' ids are used as-is; 'contact' matches are mapped to their
 * company, de-duplicated). `limit`, when given, caps the query itself
 * (returning up to limit+1 rows, so a caller can detect "more than limit"
 * without transferring an unbounded result) rather than filtering after.
 */
export async function companyIdsForDefinition(q: Queryable, definition: unknown, limit: number | null = null): Promise<number[]> {
  const compiled = await compileSegment(q, definition as SegmentDefinition)
  return idsFromCompiled(q, compiled, limit)
}

/** Every company id a STORED segment matches (a static list = its member rows; a
 *  dynamic segment = its compiled definition). Use this whenever you hold a segment row. */
export async function companyIdsForSegment(q: Queryable, seg: StoredSegmentLike, limit: number | null = null): Promise<number[]> {
  const compiled = await compileStoredSegment(q, seg)
  return idsFromCompiled(q, compiled, limit)
}

/** SQL selecting the company ids a compiled segment matches (contact segments mapped to
 *  their company). Its placeholders are the compiled params ($1..$n). */
function companyIdSubquery(compiled: CompiledSegment): string {
  const match = matchQuerySql(compiled)
  if (compiled.entity === 'company') return match
  return `select ct.company_id as id from lp.contacts ct join (${match}) m on m.id = ct.id where ct.company_id is not null`
}

/**
 * Of `candidateIds`, the ones a stored segment matches -- decided set-based in SQL, with
 * NO row cap (an exclusion list of any size excludes every one of its leads).
 */
export async function companyIdsInSegment(q: Queryable, seg: StoredSegmentLike, candidateIds: number[]): Promise<number[]> {
  if (!candidateIds.length) return []
  const compiled = await compileStoredSegment(q, seg)
  const p = compiled.params.length + 1
  const { rows } = await q.query<{ id: string | number }>(
    `select x.id from unnest($${p}::bigint[]) as x(id) where x.id in (${companyIdSubquery(compiled)})`,
    [...compiled.params, candidateIds],
  )
  return rows.map((r) => Number(r.id))
}
