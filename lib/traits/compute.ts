/**
 * Computed traits: definition -> lp.trait_values rows. Aggregation runs in
 * SQL (one query per trait per recompute) over lp.lead_events; nothing is
 * pulled into JS and summed there, so a trait over a large event stream still
 * costs one query.
 *
 * Incremental recompute: the dirty set is every company/contact that has at
 * least one lead_event RECORDED (not occurred -- a backfilled old event still
 * marks its lead dirty the run after it lands) since the trait's
 * last_computed_at. Those entities are then recomputed over the trait's full
 * window, left-joined from the dirty id list so an entity whose only matching
 * events just aged out of the window gets its value cleared (NULL / 0), not
 * left stale. This is why an incremental run matches a full recompute on the
 * entities it touches: "dirty" only decides WHO is recomputed, not HOW.
 */
import type { Queryable } from '../db/types.ts'
import type { TraitDefinition, TraitAggregation } from './definition.ts'
import type { Trait } from './store.ts'

function idCol(entity: 'company' | 'contact'): 'company_id' | 'contact_id' {
  return entity === 'company' ? 'company_id' : 'contact_id'
}

function aggExpr(agg: TraitAggregation, prop: string | null): string {
  // `prop` is validated upstream (definition.ts: PROP_PATH_RE, a lowercase slug) before it
  // ever reaches here -- the same trust boundary as lib/segments/fields.ts's field.sql:
  // never a request body's raw string spliced in unchecked.
  switch (agg) {
    case 'count':
      return 'count(e.id)::numeric'
    case 'sum':
      return `sum((e.props ->> '${prop}')::numeric)`
    case 'min':
      return `min((e.props ->> '${prop}')::numeric)`
    case 'max':
      return `max((e.props ->> '${prop}')::numeric)`
    case 'last':
      return `(array_agg(e.props ->> '${prop}' order by e.occurred_at desc) filter (where e.id is not null))[1]::numeric`
    case 'days_since':
      return 'extract(epoch from (now() - max(e.occurred_at))) / 86400.0'
  }
}

/** The event-side ON clause (after `e.${col} = d.id and `), with its own params, numbered
 *  starting at placeholder index `start`. window_days and prop paths are both already
 *  validated upstream (an integer; a lowercase slug) so they are interpolated directly --
 *  only a prop filter's VALUE is untrusted, and that always goes through a placeholder. */
function eventJoinClause(def: TraitDefinition, start: number): { sql: string; params: unknown[] } {
  let sql = `e.type = any($${start}::text[])`
  const params: unknown[] = [def.event_types]
  let n = start
  if (def.window_days != null) {
    sql += ` and e.occurred_at >= now() - interval '${def.window_days} days'`
  }
  for (const f of def.prop_filters) {
    n += 1
    params.push(f.op === 'contains' ? `%${f.value}%` : f.value)
    const op = f.op === 'contains' ? 'ilike' : '='
    sql += ` and (e.props ->> '${f.path}') ${op} $${n}`
  }
  return { sql, params }
}

interface ComputedValue {
  entity_id: number
  value: number | null
}

/** Compute this trait for exactly `ids` (dirty-set recompute), or for every id currently
 *  in the entity's table (full recompute, `ids: 'all'`). Entities with no matching event
 *  come back with value null (count comes back 0 -- "zero events" is a known fact; sum/min/
 *  max/last/days_since come back null -- "never happened" is not the same as zero). */
export async function computeTraitValues(q: Queryable, trait: Pick<Trait, 'entity' | 'definition'>, ids: number[] | 'all'): Promise<ComputedValue[]> {
  const col = idCol(trait.entity)
  const table = trait.entity === 'company' ? 'lp.companies' : 'lp.contacts'
  // $1 is always the id source (either the explicit array, or a no-op placeholder when
  // selecting every id); the event clause's own params start right after it at $2.
  const { sql: joinSql, params: joinParams } = eventJoinClause(trait.definition, 2)
  const idsSql = ids === 'all' ? `(select id from ${table})` : `(select unnest($1::bigint[]))`
  const finalParams = ids === 'all' ? joinParams : [ids, ...joinParams]
  // When ids === 'all' there is no $1 bound to an id array, so the event clause (built
  // assuming $2 is its first placeholder) must be rebuilt starting at $1 instead.
  const clause = ids === 'all' ? eventJoinClause(trait.definition, 1) : { sql: joinSql, params: joinParams }
  const sql = `
    select d.id as entity_id, ${aggExpr(trait.definition.aggregation, trait.definition.prop)} as value
      from ${idsSql} as d(id)
      left join lp.lead_events e on e.${col} = d.id and ${clause.sql}
     group by d.id`
  const params = ids === 'all' ? clause.params : finalParams
  const { rows } = await q.query<{ entity_id: string | number; value: string | number | null }>(sql, params)
  return rows.map((r) => ({ entity_id: Number(r.entity_id), value: r.value == null ? null : Number(r.value) }))
}

/** Every company/contact id that has had a lead_event recorded since `since` (or every id,
 *  when `since` is null -- a trait that has never been computed is "all dirty"). */
export async function dirtyIds(q: Queryable, entity: 'company' | 'contact', since: string | null): Promise<number[]> {
  const col = idCol(entity)
  if (since == null) {
    const table = entity === 'company' ? 'lp.companies' : 'lp.contacts'
    const { rows } = await q.query<{ id: number }>(`select id from ${table}`)
    return rows.map((r) => Number(r.id))
  }
  const { rows } = await q.query<{ id: number }>(
    `select distinct ${col} as id from lp.lead_events where recorded_at > $1 and ${col} is not null`,
    [since],
  )
  return rows.map((r) => Number(r.id))
}

/** Upsert computed values into lp.trait_values. A null value still writes a row (not a
 *  delete): "computed, and the answer is unset" is different from "never computed". */
export async function writeTraitValues(q: Queryable, traitKey: string, entity: 'company' | 'contact', values: ComputedValue[]): Promise<number> {
  if (values.length === 0) return 0
  const col = idCol(entity)
  const ids = values.map((v) => v.entity_id)
  const vals = values.map((v) => v.value)
  // PGlite and node-postgres both take a bulk unnest() just fine; this is one round trip
  // regardless of how many entities are dirty.
  const { rowCount } = await q.query(
    `insert into lp.trait_values (trait_key, ${col}, value, computed_at)
       select $1, u.id, u.value, now()
         from unnest($2::bigint[], $3::numeric[]) as u(id, value)
     on conflict (trait_key, ${col}) where ${col} is not null
     do update set value = excluded.value, computed_at = excluded.computed_at`,
    [traitKey, ids, vals],
  )
  return rowCount ?? values.length
}

export interface RecomputeResult {
  trait_key: string
  entities_touched: number
  mode: 'full' | 'incremental'
}

/** Recompute one trait: incremental (default) touches only entities dirty since its
 *  last_computed_at; `full: true` recomputes every entity regardless. Either way, the
 *  trait's last_computed_at is advanced to the moment this run started (not finished --
 *  an event recorded mid-run is safely picked up by the NEXT run, never lost). */
export async function recomputeOneTrait(q: Queryable, trait: Trait, opts: { full?: boolean } = {}): Promise<RecomputeResult> {
  const startedAt = new Date().toISOString()
  const ids = opts.full || trait.last_computed_at == null ? await dirtyIds(q, trait.entity, null) : await dirtyIds(q, trait.entity, trait.last_computed_at)
  let touched = 0
  if (ids.length > 0) {
    const values = await computeTraitValues(q, trait, ids)
    touched = await writeTraitValues(q, trait.key, trait.entity, values)
  }
  await q.query(`update lp.traits set last_computed_at = $2 where key = $1`, [trait.key, startedAt])
  return { trait_key: trait.key, entities_touched: touched, mode: opts.full ? 'full' : 'incremental' }
}
