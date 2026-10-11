/**
 * Definition -> ONE parameterized SQL query. No value is ever concatenated
 * into SQL text: every value a condition carries goes through `add()`, which
 * appends it to a plain params array and hands back a "$N" placeholder --
 * exactly the same path for an innocent value and an injection attempt (it
 * just becomes the literal text of someone's name). The only thing that ever
 * becomes raw SQL text is a field's `sql` identifier, and that always comes
 * from the registry (lib/segments/fields.ts), never from a request body.
 */
import type { Queryable } from '../db/types.ts'
import {
  DefinitionError,
  validateDefinition,
  type Condition,
  type ConditionGroup,
  type SegmentDefinition,
  type SegmentEntity,
} from './definition.ts'
import { requireField, type FieldDef } from './fields.ts'
import { ensureTraitFieldsRegistered } from '../traits/register.ts'

const MAX_SEGMENT_DEPTH = 3

interface CompileContext {
  db: Queryable
  /** segment ids currently being compiled, for cycle + depth detection (in_segment / not_in_segment). */
  stack: number[]
}

type Adder = (v: unknown) => string

function makeAdder(params: unknown[]): Adder {
  return (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }
}

function fieldAlias(field: FieldDef): 'c' | 'ct' {
  return field.table === 'company' ? 'c' : 'ct'
}

/** A contact-table field used on a company-entity segment has no single contact
 *  row to read -- wrap it as "does at least one of this company's contacts match". */
function wrapForEntity(entity: SegmentEntity, usesContactAlias: boolean, exprSql: string): string {
  if (entity === 'contact' || !usesContactAlias) return exprSql
  return `exists (select 1 from lp.contacts ct where ct.company_id = c.id and ${exprSql})`
}

function buildFieldOpSql(field: FieldDef, cond: Extract<Condition, { kind: 'field' }>, add: Adder): string {
  const expr = field.sql
  const op = cond.op
  switch (op) {
    case 'is':
      return field.type === 'boolean' ? `${expr} is ${cond.value ? 'true' : 'false'}` : `${expr} = ${add(cond.value)}`
    case 'is_not':
      return field.type === 'boolean' ? `${expr} is not ${cond.value ? 'true' : 'false'}` : `${expr} is distinct from ${add(cond.value)}`
    case 'contains':
      if (field.type === 'array') return `${expr} @> array[${add(cond.value)}]::text[]`
      return `${expr} ilike ${add(`%${String(cond.value).replace(/[%_]/g, (m) => `\\${m}`)}%`)}`
    case 'not_contains':
      if (field.type === 'array') return `not (${expr} @> array[${add(cond.value)}]::text[])`
      return `(${expr} is null or ${expr} not ilike ${add(`%${String(cond.value).replace(/[%_]/g, (m) => `\\${m}`)}%`)})`
    case 'in': {
      const vals = cond.value as unknown[]
      if (field.type === 'array') return `${expr} && ${add(vals)}::text[]`
      return `${expr} = any(${add(vals)})`
    }
    case 'not_in': {
      const vals = cond.value as unknown[]
      if (field.type === 'array') return `not (${expr} && ${add(vals)}::text[])`
      return `(${expr} is null or not (${expr} = any(${add(vals)})))`
    }
    case 'gt': return `${expr} > ${add(cond.value)}`
    case 'gte': return `${expr} >= ${add(cond.value)}`
    case 'lt': return `${expr} < ${add(cond.value)}`
    case 'lte': return `${expr} <= ${add(cond.value)}`
    case 'between': return `${expr} between ${add(cond.value)} and ${add(cond.value2)}`
    case 'before': return `${expr} < ${add(cond.value)}`
    case 'after': return `${expr} > ${add(cond.value)}`
    case 'within_last_days': return `(${expr} is not null and ${expr} >= now() - (${add(cond.value)} || ' days')::interval)`
    case 'more_than_days_ago': return `(${expr} is not null and ${expr} < now() - (${add(cond.value)} || ' days')::interval)`
    case 'exists':
      return field.type === 'array' ? `(${expr} is not null and cardinality(${expr}) > 0)` : `${expr} is not null`
    case 'not_exists':
      return field.type === 'array' ? `(${expr} is null or cardinality(${expr}) = 0)` : `${expr} is null`
    default:
      throw new DefinitionError(`unhandled operator "${op}"`)
  }
}

function compileFieldCondition(entity: SegmentEntity, cond: Extract<Condition, { kind: 'field' }>, add: Adder): string {
  const field = requireField(cond.field)
  const sql = buildFieldOpSql(field, cond, add)
  return wrapForEntity(entity, fieldAlias(field) === 'ct', sql)
}

const PROP_PATH_RE = /^props\.([a-z][a-z0-9_]{0,63})$/

function compileEventCondition(entity: SegmentEntity, cond: Extract<Condition, { kind: 'event' }>, add: Adder): string {
  const idCol = entity === 'company' ? 'c.id' : 'ct.id'
  const matchCol = entity === 'company' ? 'company_id' : 'contact_id'
  const parts = [`${matchCol} = ${idCol}`, `type = ${add(cond.event_type)}`]
  if (cond.within_last_days != null) parts.push(`occurred_at >= now() - (${add(cond.within_last_days)} || ' days')::interval`)
  if (cond.prop) {
    const m = PROP_PATH_RE.exec(cond.prop.path)
    if (!m) throw new DefinitionError(`event condition: bad prop path "${cond.prop.path}"`)
    const keyPlaceholder = add(m[1])
    if (cond.prop.op === 'contains') parts.push(`(props ->> ${keyPlaceholder}) ilike ${add(`%${cond.prop.value.replace(/[%_]/g, (c) => `\\${c}`)}%`)}`)
    else parts.push(`(props ->> ${keyPlaceholder}) = ${add(cond.prop.value)}`)
  }
  const countExpr = `(select count(*) from lp.lead_events where ${parts.join(' and ')})`
  const opSql = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[cond.count_op]
  return `${countExpr} ${opSql} ${add(cond.count)}`
}

function compileRelativeDate(entity: SegmentEntity, cond: Extract<Condition, { kind: 'relative_date' }>, add: Adder): string {
  const field = requireField(cond.field)
  let compareExpr = 'now()'
  let compareUsesContact = false
  if (cond.compare_to) {
    const cf = requireField(cond.compare_to)
    compareExpr = cf.sql
    compareUsesContact = fieldAlias(cf) === 'ct'
  }
  const offset = `(${add(cond.days)} || ' days')::interval`
  const exprSql = cond.op === 'before' ? `${field.sql} < (${compareExpr} - ${offset})` : `${field.sql} > (${compareExpr} + ${offset})`
  const usesContact = fieldAlias(field) === 'ct' || compareUsesContact
  return wrapForEntity(entity, usesContact, exprSql)
}

function compileCampaignMembership(cond: Extract<Condition, { kind: 'campaign_membership' }>, add: Adder): string {
  if (cond.mode === 'in_campaign') {
    return `exists (select 1 from lp.campaign_leads cl where cl.company_id = c.id and cl.campaign_id = ${add(cond.campaign_id)})`
  }
  if (cond.mode === 'any_active_campaign') {
    return `exists (select 1 from lp.campaign_leads cl join lp.campaigns camp on camp.id = cl.campaign_id where cl.company_id = c.id and camp.status = 'active')`
  }
  return `not exists (select 1 from lp.campaign_leads cl where cl.company_id = c.id)`
}

/** Exported so compile.ts's own count/preview queries (verified-sendable counts) use the
 *  exact same definition of "sendable" that a `quality` condition compiles to. */
export function verifiedSendableSql(alias: 'ct' = 'ct'): string {
  return `(${alias}.verification_status = 'valid' and ${alias}.subscription_status <> 'unsubscribed' and not ${alias}.do_not_contact and not lp.is_suppressed(${alias}.email))`
}

function compileQuality(entity: SegmentEntity, cond: Extract<Condition, { kind: 'quality' }>): string {
  if (cond.op === 'suppressed' || cond.op === 'not_suppressed') {
    const base = entity === 'contact' ? 'lp.is_suppressed(ct.email)' : `exists (select 1 from lp.contacts ct where ct.company_id = c.id and lp.is_suppressed(ct.email))`
    return cond.op === 'suppressed' ? base : `not (${base})`
  }
  const base = entity === 'contact' ? verifiedSendableSql('ct') : `exists (select 1 from lp.contacts ct where ct.company_id = c.id and ${verifiedSendableSql('ct')})`
  return cond.op === 'verified_sendable' ? base : `not (${base})`
}

async function compileSegmentRef(
  ctx: CompileContext,
  entity: SegmentEntity,
  cond: Extract<Condition, { kind: 'in_segment' | 'not_in_segment' }>,
  add: Adder,
): Promise<string> {
  if (ctx.stack.length >= MAX_SEGMENT_DEPTH) throw new DefinitionError(`segment nesting is limited to ${MAX_SEGMENT_DEPTH} levels deep`)
  if (ctx.stack.includes(cond.segment_id)) throw new DefinitionError(`segment ${cond.segment_id} refers back to itself (cycle)`)
  const { rows } = await ctx.db.query<{ id: number; entity: string; kind: string; definition: unknown }>(
    `select id, entity, kind, definition from lp.segments where id = $1 and archived_at is null`,
    [cond.segment_id],
  )
  const refRow = rows[0]
  if (!refRow) throw new DefinitionError(`segment ${cond.segment_id} not found (or archived)`)
  if (refRow.entity !== entity) throw new DefinitionError(`segment ${cond.segment_id} is a "${refRow.entity}" segment; in_segment here requires a "${entity}" segment`)
  if (refRow.kind === 'static') {
    // A static list's membership is its stored rows, never its (empty) definition --
    // an empty definition compiles to `true` and would match every lead.
    const verb = cond.kind === 'in_segment' ? 'in' : 'not in'
    return `${entity === 'company' ? 'c.id' : 'ct.id'} ${verb} (${staticMembersSql(entity, add(refRow.id))})`
  }
  const refDef = validateDefinition(refRow.definition)
  const subCtx: CompileContext = { db: ctx.db, stack: [...ctx.stack, cond.segment_id] }
  // Re-using the alias names c / ct inside this subquery is deliberate: SQL scoping lets
  // the inner SELECT's c / ct shadow the outer ones, so the referenced segment's own
  // compiled WHERE runs unmodified against its own fresh FROM. Threading the SAME outer
  // `add`/params through (instead of a separate param list) means every value the
  // referenced segment's conditions need lands directly in the one params array the
  // top-level query is executed with -- no renumbering, no risk of an orphaned param list.
  const whereSql = await compileDefinitionWhere(subCtx, entity, refDef, add)
  const from = entity === 'company' ? 'lp.companies c' : 'lp.contacts ct join lp.companies c on c.id = ct.company_id'
  const idCol = entity === 'company' ? 'c.id' : 'ct.id'
  const outerId = entity === 'company' ? 'c.id' : 'ct.id'
  const verb = cond.kind === 'in_segment' ? 'in' : 'not in'
  return `${outerId} ${verb} (select ${idCol} from ${from} where ${whereSql})`
}

async function compileCondition(ctx: CompileContext, entity: SegmentEntity, cond: Condition, add: Adder): Promise<string> {
  switch (cond.kind) {
    case 'field': return compileFieldCondition(entity, cond, add)
    case 'event': return compileEventCondition(entity, cond, add)
    case 'relative_date': return compileRelativeDate(entity, cond, add)
    case 'campaign_membership': return compileCampaignMembership(cond, add)
    case 'quality': return compileQuality(entity, cond)
    case 'in_segment':
    case 'not_in_segment':
      return compileSegmentRef(ctx, entity, cond, add)
    default:
      throw new DefinitionError(`unhandled condition kind`)
  }
}

async function compileGroupAnd(ctx: CompileContext, entity: SegmentEntity, group: ConditionGroup, add: Adder): Promise<string> {
  const parts: string[] = []
  for (const cond of group.conditions) parts.push(await compileCondition(ctx, entity, cond, add))
  return `(${parts.join(' and ')})`
}

async function compileDefinitionWhere(ctx: CompileContext, entity: SegmentEntity, def: SegmentDefinition, add: Adder): Promise<string> {
  let includeSql = 'true'
  if (def.include.length) {
    const parts: string[] = []
    for (const g of def.include) parts.push(await compileGroupAnd(ctx, entity, g, add))
    includeSql = `(${parts.join(' or ')})`
  }
  let excludeSql = 'true'
  if (def.exclude.length) {
    const parts: string[] = []
    for (const g of def.exclude) parts.push(await compileGroupAnd(ctx, entity, g, add))
    // coalesce: a NULL field must count as "doesn't match the exclusion" ("everyone
    // except NY" keeps leads with no state), not drop the row via SQL's NULL logic.
    excludeSql = `not coalesce((${parts.join(' or ')}), false)`
  }
  return `(${includeSql}) and (${excludeSql})`
}

export interface CompiledSegment {
  entity: SegmentEntity
  fromSql: string
  idSql: string
  whereSql: string
  params: unknown[]
}

/** Compile a definition into a reusable WHERE clause + its FROM + its params.
 *  Re-validates the definition (cheap; a stored row should never be trusted
 *  blindly) before compiling it. */
export async function compileSegment(db: Queryable, rawDefinition: unknown): Promise<CompiledSegment> {
  // Computed traits (2.7) register their field lazily, from the DB, so a trait defined
  // five minutes ago is usable in a segment condition without a deploy.
  await ensureTraitFieldsRegistered(db)
  const def = validateDefinition(rawDefinition)
  const params: unknown[] = []
  const add = makeAdder(params)
  const ctx: CompileContext = { db, stack: [] }
  const whereSql = await compileDefinitionWhere(ctx, def.entity, def, add)
  const fromSql = def.entity === 'company' ? 'lp.companies c' : 'lp.contacts ct join lp.companies c on c.id = ct.company_id'
  const idSql = def.entity === 'company' ? 'c.id' : 'ct.id'
  return { entity: def.entity, fromSql, idSql, whereSql, params }
}

/** The member-id subquery for a static list (column never NULL, so `not in` is safe). */
function staticMembersSql(entity: SegmentEntity, segmentIdParam: string): string {
  const col = entity === 'company' ? 'company_id' : 'contact_id'
  return `select sm.${col} from lp.segment_members sm where sm.segment_id = ${segmentIdParam} and sm.${col} is not null`
}

/** A stored segment row, as far as compiling it needs. */
export interface StoredSegmentLike {
  id: number
  kind: string
  entity: SegmentEntity | string
  definition: unknown
}

/** Compile a STORED segment: a static list matches its lp.segment_members rows; a dynamic
 *  segment compiles its definition. Every caller holding a segment row must use this
 *  (not compileSegment(seg.definition)), or a static list matches every lead. */
export async function compileStoredSegment(db: Queryable, seg: StoredSegmentLike): Promise<CompiledSegment> {
  if (seg.kind !== 'static') return compileSegment(db, seg.definition)
  const entity: SegmentEntity = seg.entity === 'contact' ? 'contact' : 'company'
  const params: unknown[] = []
  const add = makeAdder(params)
  const idSql = entity === 'company' ? 'c.id' : 'ct.id'
  const fromSql = entity === 'company' ? 'lp.companies c' : 'lp.contacts ct join lp.companies c on c.id = ct.company_id'
  return { entity, fromSql, idSql, whereSql: `${idSql} in (${staticMembersSql(entity, add(Number(seg.id)))})`, params }
}

/** The one SELECT every other query (counts, members, samples) is built from: distinct matching ids. */
export function matchQuerySql(compiled: CompiledSegment): string {
  return `select distinct ${compiled.idSql} as id from ${compiled.fromSql} where ${compiled.whereSql}`
}

export interface SegmentCounts {
  companies: number
  contacts: number
  verified_sendable: number
}

function toInt(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export async function countSegment(db: Queryable, compiled: CompiledSegment): Promise<SegmentCounts> {
  const base = matchQuerySql(compiled)
  if (compiled.entity === 'company') {
    const sql = `
      with matched as (${base})
      select
        (select count(*)::int from matched) as companies,
        (select count(*)::int from lp.contacts ct where ct.company_id in (select id from matched)) as contacts,
        (select count(*)::int from lp.contacts ct where ct.company_id in (select id from matched) and ${verifiedSendableSql('ct')}) as verified_sendable
    `
    const { rows } = await db.query<{ companies: number; contacts: number; verified_sendable: number }>(sql, compiled.params)
    const r = rows[0]
    return { companies: toInt(r?.companies), contacts: toInt(r?.contacts), verified_sendable: toInt(r?.verified_sendable) }
  }
  const sql = `
    with matched as (${base})
    select
      (select count(distinct ct.company_id)::int from lp.contacts ct where ct.id in (select id from matched)) as companies,
      (select count(*)::int from matched) as contacts,
      (select count(*)::int from lp.contacts ct where ct.id in (select id from matched) and ${verifiedSendableSql('ct')}) as verified_sendable
  `
  const { rows } = await db.query<{ companies: number; contacts: number; verified_sendable: number }>(sql, compiled.params)
  const r = rows[0]
  return { companies: toInt(r?.companies), contacts: toInt(r?.contacts), verified_sendable: toInt(r?.verified_sendable) }
}

/** `limit` is a validated plain integer (never request text), safe to inline. */
export async function sampleRows(db: Queryable, compiled: CompiledSegment, limit = 10): Promise<Record<string, unknown>[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 10, 1), 100)
  const base = matchQuerySql(compiled)
  if (compiled.entity === 'company') {
    const { rows } = await db.query(
      `select c.id, c.name, c.city, c.state, c.stage, c.segment as pool, c.website_domain
         from lp.companies c join (${base}) m on m.id = c.id
        order by c.id desc limit ${safeLimit}`,
      compiled.params,
    )
    return rows
  }
  const { rows } = await db.query(
    `select ct.id, ct.email, ct.first_name, ct.last_name, ct.status, ct.verification_status, c.name as company_name
       from lp.contacts ct join lp.companies c on c.id = ct.company_id
       join (${base}) m on m.id = ct.id
      order by ct.id desc limit ${safeLimit}`,
    compiled.params,
  )
  return rows
}

/** Every matching id, for membership listing / snapshotting (lib/segments/ops.ts). */
export async function matchingIds(db: Queryable, compiled: CompiledSegment, opts: { limit?: number; offset?: number } = {}): Promise<number[]> {
  const limit = Math.min(Math.max(Math.trunc(Number(opts.limit)) || 1000, 1), 10000)
  const offset = Math.max(Math.trunc(Number(opts.offset)) || 0, 0)
  const sql = `${matchQuerySql(compiled)} order by id limit ${limit} offset ${offset}`
  const { rows } = await db.query<{ id: number }>(sql, compiled.params)
  return rows.map((r) => r.id)
}
