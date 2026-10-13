/**
 * The segment definition DSL: one JSON shape, one strict validator. Every
 * write (the dashboard's segment builder, an agent's create_segment /
 * update_segment, a stored lp.segments.definition row re-checked on compile)
 * goes through `validateDefinition` -- unknown fields and unknown operators
 * are rejected with a plain error, never silently ignored.
 *
 *   entity   'company' | 'contact' -- which table a match is a row of.
 *   include  condition groups, OR'd across groups, AND'd within a group.
 *            Empty include = "match everyone" (a segment that is exclude-only,
 *            e.g. "everyone except suppressed", is legitimate).
 *   exclude  same shape; a record matching ANY exclude group is dropped.
 *
 * Condition kinds, each documented where it is compiled (lib/segments/compile.ts):
 *   field               a field-registry column compared with an operator + value(s)
 *   event               a count of lp.lead_events of one type, in a window, vs N
 *   relative_date       one date field vs another date field (or "now"), offset by N days
 *   in_segment / not_in_segment   membership in another (same-entity) segment
 *   radius              within N miles of a point (TAP-171; lat/lng from lib/geo/geocode.ts)
 *   campaign_membership in a specific campaign / any active campaign / never contacted
 *   quality             suppressed / not_suppressed / verified_sendable / not_verified_sendable
 */
import { getField, type FieldType } from './fields.ts'
import { isValidLatLng, MAX_RADIUS_MILES } from '../geo/distance.ts'

export class DefinitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DefinitionError'
  }
}

export const FIELD_OPS = [
  'is', 'is_not', 'contains', 'not_contains', 'in', 'not_in',
  'gt', 'gte', 'lt', 'lte', 'between',
  'before', 'after', 'within_last_days', 'more_than_days_ago',
  'exists', 'not_exists',
] as const
export type FieldOp = (typeof FIELD_OPS)[number]

export const OPS_BY_TYPE: Record<FieldType, readonly FieldOp[]> = {
  text: ['is', 'is_not', 'contains', 'not_contains', 'in', 'not_in', 'exists', 'not_exists'],
  number: ['is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in', 'exists', 'not_exists'],
  date: ['is', 'is_not', 'before', 'after', 'within_last_days', 'more_than_days_ago', 'between', 'exists', 'not_exists'],
  boolean: ['is', 'is_not', 'exists', 'not_exists'],
  array: ['contains', 'not_contains', 'in', 'not_in', 'exists', 'not_exists'],
}

export interface FieldCondition {
  kind: 'field'
  field: string
  op: FieldOp
  value?: unknown
  value2?: unknown // only for 'between'
}

export interface EventPropFilter {
  /** "props.<key>" -- a single top-level key of lp.lead_events.props. */
  path: string
  op: 'is' | 'contains'
  value: string
}

export interface EventCondition {
  kind: 'event'
  event_type: string
  count_op: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'
  count: number
  within_last_days?: number
  prop?: EventPropFilter
}

export interface RelativeDateCondition {
  kind: 'relative_date'
  field: string
  op: 'before' | 'after'
  days: number
  /** A date field key, or 'now' (default). */
  compare_to?: string
}

export interface SegmentRefCondition {
  kind: 'in_segment' | 'not_in_segment'
  segment_id: number
}

export interface CampaignMembershipCondition {
  kind: 'campaign_membership'
  mode: 'in_campaign' | 'any_active_campaign' | 'never_contacted'
  campaign_id?: number
}

export interface QualityCondition {
  kind: 'quality'
  op: 'suppressed' | 'not_suppressed' | 'verified_sendable' | 'not_verified_sendable'
}

/** Leads whose company sits within `miles` of a point (TAP-171). The point is stored
 *  resolved (lat/lng), so a saved segment never depends on a geocoder at compile time;
 *  `place` keeps the words it came from, for the readback and the builder. */
export interface RadiusCondition {
  kind: 'radius'
  lat: number
  lng: number
  miles: number
  place?: string
}

export type Condition =
  | FieldCondition
  | EventCondition
  | RelativeDateCondition
  | SegmentRefCondition
  | CampaignMembershipCondition
  | QualityCondition
  | RadiusCondition

export interface ConditionGroup {
  conditions: Condition[]
}

export type SegmentEntity = 'company' | 'contact'

export interface SegmentDefinition {
  entity: SegmentEntity
  include: ConditionGroup[]
  exclude: ConditionGroup[]
}

function fail(msg: string): never {
  throw new DefinitionError(msg)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function assertOnlyKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`${where}: unknown field "${k}" (allowed: ${allowed.join(', ')})`)
  }
}

function coerceValueForType(type: FieldType, value: unknown, where: string): unknown {
  if (type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) fail(`${where}: value must be a number, got ${JSON.stringify(value)}`)
    return n
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    fail(`${where}: value must be a boolean`)
  }
  if (type === 'date') {
    const d = value instanceof Date ? value : new Date(String(value))
    if (Number.isNaN(d.getTime())) fail(`${where}: value must be a date (ISO string), got ${JSON.stringify(value)}`)
    return d.toISOString()
  }
  // text / array elements: stored as a plain string, parameterized at compile time --
  // never concatenated into SQL, so there is no "dangerous value" here.
  return String(value)
}

function validateFieldCondition(c: Record<string, unknown>): FieldCondition {
  assertOnlyKeys(c, ['kind', 'field', 'op', 'value', 'value2'], 'field condition')
  const key = typeof c.field === 'string' ? c.field : fail('field condition: "field" is required')
  const def = getField(key)
  if (!def) fail(`field condition: unknown field "${key}"`)
  const op = c.op
  if (typeof op !== 'string' || !(FIELD_OPS as readonly string[]).includes(op)) fail(`field condition "${key}": unknown operator "${String(op)}"`)
  const allowed = def.operators ?? OPS_BY_TYPE[def.type]
  if (!allowed.includes(op as FieldOp)) fail(`field condition "${key}": operator "${op}" is not valid for a ${def.type} field (allowed: ${allowed.join(', ')})`)
  const needsValue = op !== 'exists' && op !== 'not_exists'
  if (!needsValue) return { kind: 'field', field: key, op: op as FieldOp }
  if (op === 'between') {
    if (!('value' in c) || !('value2' in c)) fail(`field condition "${key}": "between" requires value and value2`)
    return {
      kind: 'field', field: key, op,
      value: coerceValueForType(def.type, c.value, `field "${key}" value`),
      value2: coerceValueForType(def.type, c.value2, `field "${key}" value2`),
    }
  }
  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(c.value) || c.value.length === 0) fail(`field condition "${key}": "${op}" requires a non-empty array value`)
    return { kind: 'field', field: key, op, value: c.value.map((v) => coerceValueForType(def.type === 'array' ? 'text' : def.type, v, `field "${key}" value`)) }
  }
  if (op === 'within_last_days' || op === 'more_than_days_ago') {
    const n = Number(c.value)
    if (!Number.isFinite(n) || n < 0) fail(`field condition "${key}": "${op}" requires a non-negative number of days`)
    return { kind: 'field', field: key, op, value: n }
  }
  if (!('value' in c)) fail(`field condition "${key}": "${op}" requires a value`)
  return { kind: 'field', field: key, op: op as FieldOp, value: coerceValueForType(def.type === 'array' ? 'text' : def.type, c.value, `field "${key}" value`) }
}

function validateEventCondition(c: Record<string, unknown>): EventCondition {
  assertOnlyKeys(c, ['kind', 'event_type', 'count_op', 'count', 'within_last_days', 'prop'], 'event condition')
  const event_type = typeof c.event_type === 'string' && c.event_type.trim() ? c.event_type.trim() : fail('event condition: "event_type" is required')
  const COUNT_OPS = ['eq', 'gt', 'gte', 'lt', 'lte']
  if (typeof c.count_op !== 'string' || !COUNT_OPS.includes(c.count_op)) fail(`event condition "${event_type}": count_op must be one of ${COUNT_OPS.join(', ')}`)
  const count = Number(c.count)
  if (!Number.isFinite(count) || count < 0) fail(`event condition "${event_type}": count must be a non-negative number`)
  const out: EventCondition = { kind: 'event', event_type, count_op: c.count_op as EventCondition['count_op'], count }
  if (c.within_last_days != null) {
    const d = Number(c.within_last_days)
    if (!Number.isFinite(d) || d <= 0) fail(`event condition "${event_type}": within_last_days must be a positive number`)
    out.within_last_days = d
  }
  if (c.prop != null) {
    if (!isPlainObject(c.prop)) fail(`event condition "${event_type}": prop must be an object`)
    assertOnlyKeys(c.prop, ['path', 'op', 'value'], `event condition "${event_type}" prop`)
    const path = typeof c.prop.path === 'string' ? c.prop.path : fail(`event condition "${event_type}": prop.path is required`)
    if (!/^props\.[a-z][a-z0-9_]{0,63}$/.test(path)) fail(`event condition "${event_type}": prop.path must look like "props.<key>"`)
    const propOp = c.prop.op
    if (propOp !== 'is' && propOp !== 'contains') fail(`event condition "${event_type}": prop.op must be "is" or "contains"`)
    out.prop = { path, op: propOp, value: String(c.prop.value ?? '') }
  }
  return out
}

function validateRelativeDateCondition(c: Record<string, unknown>): RelativeDateCondition {
  assertOnlyKeys(c, ['kind', 'field', 'op', 'days', 'compare_to'], 'relative_date condition')
  const key = typeof c.field === 'string' ? c.field : fail('relative_date condition: "field" is required')
  const def = getField(key)
  if (!def) fail(`relative_date condition: unknown field "${key}"`)
  if (def.type !== 'date') fail(`relative_date condition: field "${key}" is not a date field`)
  if (c.op !== 'before' && c.op !== 'after') fail(`relative_date condition "${key}": op must be "before" or "after"`)
  const days = Number(c.days)
  if (!Number.isFinite(days) || days < 0) fail(`relative_date condition "${key}": days must be a non-negative number`)
  const out: RelativeDateCondition = { kind: 'relative_date', field: key, op: c.op, days }
  if (c.compare_to != null && c.compare_to !== 'now') {
    const cmp = typeof c.compare_to === 'string' ? c.compare_to : fail(`relative_date condition "${key}": compare_to must be a field key or "now"`)
    const cdef = getField(cmp)
    if (!cdef) fail(`relative_date condition "${key}": unknown compare_to field "${cmp}"`)
    if (cdef.type !== 'date') fail(`relative_date condition "${key}": compare_to field "${cmp}" is not a date field`)
    out.compare_to = cmp
  }
  return out
}

function validateSegmentRefCondition(c: Record<string, unknown>, kind: 'in_segment' | 'not_in_segment'): SegmentRefCondition {
  assertOnlyKeys(c, ['kind', 'segment_id'], `${kind} condition`)
  const id = Number(c.segment_id)
  if (!Number.isInteger(id) || id <= 0) fail(`${kind} condition: segment_id must be a positive integer`)
  return { kind, segment_id: id }
}

function validateCampaignMembershipCondition(c: Record<string, unknown>): CampaignMembershipCondition {
  assertOnlyKeys(c, ['kind', 'mode', 'campaign_id'], 'campaign_membership condition')
  const MODES = ['in_campaign', 'any_active_campaign', 'never_contacted']
  if (typeof c.mode !== 'string' || !MODES.includes(c.mode)) fail(`campaign_membership condition: mode must be one of ${MODES.join(', ')}`)
  if (c.mode === 'in_campaign') {
    const id = Number(c.campaign_id)
    if (!Number.isInteger(id) || id <= 0) fail('campaign_membership condition: mode "in_campaign" requires a positive integer campaign_id')
    return { kind: 'campaign_membership', mode: 'in_campaign', campaign_id: id }
  }
  return { kind: 'campaign_membership', mode: c.mode as 'any_active_campaign' | 'never_contacted' }
}

function validateQualityCondition(c: Record<string, unknown>): QualityCondition {
  assertOnlyKeys(c, ['kind', 'op'], 'quality condition')
  const OPS = ['suppressed', 'not_suppressed', 'verified_sendable', 'not_verified_sendable']
  if (typeof c.op !== 'string' || !OPS.includes(c.op)) fail(`quality condition: op must be one of ${OPS.join(', ')}`)
  return { kind: 'quality', op: c.op as QualityCondition['op'] }
}

function validateRadiusCondition(c: Record<string, unknown>): RadiusCondition {
  assertOnlyKeys(c, ['kind', 'lat', 'lng', 'miles', 'place'], 'radius condition')
  if (c.lat == null || c.lng == null) {
    fail('radius condition: lat and lng are required -- look the place up first (geocode_place, or send "place" to segment_preview / create_segment / update_segment and it is resolved for you)')
  }
  const lat = Number(c.lat)
  const lng = Number(c.lng)
  if (!isValidLatLng(lat, lng)) fail('radius condition: lat must be between -90 and 90 and lng between -180 and 180')
  const miles = Number(c.miles)
  if (!Number.isFinite(miles) || miles <= 0 || miles > MAX_RADIUS_MILES) fail(`radius condition: miles must be a number above 0 and at most ${MAX_RADIUS_MILES}`)
  const out: RadiusCondition = { kind: 'radius', lat, lng, miles }
  if (c.place != null) {
    if (typeof c.place !== 'string' || c.place.length > 200) fail('radius condition: place must be a string of at most 200 characters')
    if (c.place.trim()) out.place = c.place.trim()
  }
  return out
}

function validateCondition(raw: unknown): Condition {
  if (!isPlainObject(raw)) fail('each condition must be an object')
  switch (raw.kind) {
    case 'field': return validateFieldCondition(raw)
    case 'event': return validateEventCondition(raw)
    case 'relative_date': return validateRelativeDateCondition(raw)
    case 'in_segment': return validateSegmentRefCondition(raw, 'in_segment')
    case 'not_in_segment': return validateSegmentRefCondition(raw, 'not_in_segment')
    case 'campaign_membership': return validateCampaignMembershipCondition(raw)
    case 'quality': return validateQualityCondition(raw)
    case 'radius': return validateRadiusCondition(raw)
    default:
      fail(`unknown condition kind "${String((raw as Record<string, unknown>).kind)}"`)
  }
}

function validateGroup(raw: unknown, where: string): ConditionGroup {
  if (!isPlainObject(raw)) fail(`${where}: each group must be an object`)
  assertOnlyKeys(raw, ['conditions'], where)
  if (!Array.isArray(raw.conditions) || raw.conditions.length === 0) fail(`${where}: "conditions" must be a non-empty array`)
  return { conditions: raw.conditions.map((c) => validateCondition(c)) }
}

function validateGroups(raw: unknown, where: string): ConditionGroup[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) fail(`${where} must be an array of groups`)
  return raw.map((g) => validateGroup(g, where))
}

/** The one door every segment definition goes through, on every write and
 *  again on every compile (a stored row is re-validated, not trusted blindly --
 *  cheap, and it means a bad migration/import can never silently compile). */
export function validateDefinition(raw: unknown): SegmentDefinition {
  if (!isPlainObject(raw)) fail('definition must be an object')
  assertOnlyKeys(raw, ['entity', 'include', 'exclude'], 'definition')
  if (raw.entity !== 'company' && raw.entity !== 'contact') fail('definition: "entity" must be "company" or "contact"')
  return {
    entity: raw.entity,
    include: validateGroups(raw.include, 'definition.include'),
    exclude: validateGroups(raw.exclude, 'definition.exclude'),
  }
}
