/**
 * The computed-trait definition DSL (plan 2.7): one per-lead number, built
 * from the lead event stream (lp.lead_events) once, used everywhere a
 * segment condition, a score rule or a profile card wants it. One strict
 * validator, same shape as lib/segments/definition.ts: unknown fields and
 * out-of-range values are rejected with a plain error, never silently
 * dropped.
 *
 *   event_types   one or more lp.event_types keys this trait aggregates over
 *                 (format-checked here; an unregistered type simply matches
 *                 nothing at compute time rather than erroring -- the event
 *                 registry can grow after a trait is defined).
 *   aggregation   'count'      how many matching events
 *                 'sum'        total of a numeric prop across matching events
 *                 'min'/'max'  smallest / largest numeric prop value
 *                 'last'       the prop's value on the most recent matching event
 *                 'days_since' days since the most recent matching event (null
 *                              when there has never been one -- NULL is not 0)
 *   prop          required for sum/min/max/last: the top-level key of the
 *                 event's props jsonb to read, cast numeric.
 *   window_days   only count events in the last N days; omitted/null = all time.
 *   prop_filters  optional extra conditions on props (e.g. only "meeting_booked"
 *                 events where props.kind = "demo"), AND'd together.
 */

export type TraitAggregation = 'count' | 'sum' | 'min' | 'max' | 'last' | 'days_since'
export type TraitEntity = 'company' | 'contact'

const EVENT_TYPE_RE = /^[a-z][a-z0-9_.]{0,63}$/
const PROP_PATH_RE = /^[a-z][a-z0-9_]{0,63}$/
const TRAIT_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/
const AGGREGATIONS: readonly TraitAggregation[] = ['count', 'sum', 'min', 'max', 'last', 'days_since']
const PROP_FILTER_OPS = ['is', 'contains'] as const
export type PropFilterOp = (typeof PROP_FILTER_OPS)[number]

export interface TraitPropFilter {
  path: string
  op: PropFilterOp
  value: string
}

export interface TraitDefinition {
  event_types: string[]
  aggregation: TraitAggregation
  prop: string | null
  window_days: number | null
  prop_filters: TraitPropFilter[]
}

export class TraitDefinitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TraitDefinitionError'
  }
}

function err(msg: string): never {
  throw new TraitDefinitionError(msg)
}

/** A trait's own key (lp.traits.key): the slug a segment condition or score rule names it by. */
export function validateTraitKey(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!TRAIT_KEY_RE.test(s)) err(`trait key must be a lowercase slug (letters, digits, _; starts with a letter; up to 64 chars), got ${JSON.stringify(raw)}`)
  return s
}

function cleanEventTypes(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
  if (list.length === 0) err('event_types must be a non-empty array of event type keys')
  const out = list.map((v) => {
    const s = typeof v === 'string' ? v.trim() : ''
    if (!EVENT_TYPE_RE.test(s)) err(`event_types: "${String(v)}" is not a valid event type key`)
    return s
  })
  return [...new Set(out)]
}

function cleanProp(raw: unknown, required: boolean): string | null {
  if (raw == null || raw === '') {
    if (required) err('prop is required for sum/min/max/last aggregations')
    return null
  }
  const s = String(raw).trim()
  if (!PROP_PATH_RE.test(s)) err(`prop must be a lowercase slug (letters, digits, _), got ${JSON.stringify(raw)}`)
  return s
}

function cleanWindowDays(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0 || n > 3650) err('window_days must be a positive integer (days), at most 3650, or omitted for all time')
  return n
}

function cleanPropFilters(raw: unknown): TraitPropFilter[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) err('prop_filters must be an array')
  return raw.map((f, i) => {
    if (typeof f !== 'object' || f === null) err(`prop_filters[${i}] must be an object`)
    const o = f as Record<string, unknown>
    const path = String(o.path ?? '').trim()
    if (!PROP_PATH_RE.test(path)) err(`prop_filters[${i}].path must be a lowercase slug, got ${JSON.stringify(o.path)}`)
    const op = o.op as PropFilterOp
    if (!PROP_FILTER_OPS.includes(op)) err(`prop_filters[${i}].op must be one of: ${PROP_FILTER_OPS.join(', ')}`)
    const value = String(o.value ?? '')
    if (!value) err(`prop_filters[${i}].value is required`)
    return { path, op, value }
  })
}

/** Validate a raw trait definition (from the ops API or the dashboard's builder). Throws TraitDefinitionError. */
export function validateTraitDefinition(raw: unknown): TraitDefinition {
  if (typeof raw !== 'object' || raw === null) err('definition must be an object')
  const o = raw as Record<string, unknown>
  const aggregation = o.aggregation as TraitAggregation
  if (!AGGREGATIONS.includes(aggregation)) err(`aggregation must be one of: ${AGGREGATIONS.join(', ')}`)
  const event_types = cleanEventTypes(o.event_types ?? o.event_type)
  const needsProp = aggregation === 'sum' || aggregation === 'min' || aggregation === 'max' || aggregation === 'last'
  const prop = cleanProp(o.prop, needsProp)
  const window_days = cleanWindowDays(o.window_days)
  const prop_filters = cleanPropFilters(o.prop_filters)
  return { event_types, aggregation, prop, window_days, prop_filters }
}

export function validateTraitEntity(raw: unknown): TraitEntity {
  if (raw === 'company' || raw === 'contact') return raw
  err('entity must be "company" or "contact"')
}
