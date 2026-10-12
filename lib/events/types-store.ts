/**
 * The lp.event_types registry: the one place that writes it. Used by the ops
 * (register_event_type / update_event_type in lib/events/ops.ts) and by the
 * /settings/event-types page (app/actions/event-types.ts). Every write also
 * leaves an lp.events audit row (entity_type 'event_type', entity_id = key).
 *
 * Built-in types (source 'instantly' or 'system', seeded by migration 0018) are
 * written by the Instantly webhook and the status-history trigger. Their key,
 * label, category and active flag are fixed: deactivating one would make the
 * webhook / trigger insert fail, so they can be listed but not changed.
 */
import type { Queryable } from '../db/types.ts'

export const EVENT_TYPE_SLUG = /^[a-z][a-z0-9_.]{0,63}$/
export const EVENT_TYPE_CATEGORIES = ['email', 'lifecycle', 'verification', 'web', 'social', 'meeting', 'deal', 'signal', 'custom'] as const
export const BUILT_IN_SOURCES: ReadonlySet<string> = new Set(['instantly', 'system'])

export class EventTypeError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export type EventTypeRow = {
  key: string
  label: string
  category: string
  source: string
  props_schema: unknown
  active: boolean
  created_by: string | null
  created_at: string | Date
}

const COLS = 'key, label, category, source, props_schema, active, created_by, created_at'

export const isBuiltInEventType = (t: { source: string }) => BUILT_IN_SOURCES.has(t.source)

function cleanLabel(v: unknown): string {
  const label = typeof v === 'string' ? v.trim() : ''
  if (!label || label.length > 80) throw new EventTypeError('label is required (max 80 characters)')
  return label
}
function cleanCategory(v: unknown): string {
  const c = typeof v === 'string' ? v : ''
  if (!(EVENT_TYPE_CATEGORIES as readonly string[]).includes(c)) throw new EventTypeError(`category must be one of: ${EVENT_TYPE_CATEGORIES.join(', ')}`)
  return c
}

async function audit(q: Queryable, actor: string, kind: string, key: string, summary: string, data: unknown) {
  await q.query(`insert into lp.events (actor, kind, summary, entity_type, entity_id, data) values ($1, $2, $3, 'event_type', $4, $5)`, [actor, kind, summary, key, JSON.stringify(data)])
}

/**
 * Register a new type (or relabel/recategorise an existing custom one with the
 * same key). `source` defaults to 'agent' (ops) — the settings page passes 'dashboard'.
 * Refuses to touch a built-in type.
 */
export async function registerEventType(
  q: Queryable,
  actor: string,
  input: { key: unknown; label: unknown; category: unknown; props_schema?: unknown; source?: string },
): Promise<EventTypeRow> {
  const key = typeof input.key === 'string' ? input.key.trim() : ''
  if (!EVENT_TYPE_SLUG.test(key)) throw new EventTypeError("key must be a lowercase slug, e.g. 'review_posted' (letters, digits, '_' or '.', starting with a letter)")
  const label = cleanLabel(input.label)
  const category = cleanCategory(input.category)
  const { rows } = await q.query<EventTypeRow>(
    `insert into lp.event_types (key, label, category, source, props_schema, created_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (key) do update set label = excluded.label, category = excluded.category
       where lp.event_types.source not in ('instantly', 'system')
     returning ${COLS}`,
    [key, label, category, input.source ?? 'agent', input.props_schema === undefined ? null : JSON.stringify(input.props_schema), actor],
  )
  if (!rows[0]) throw new EventTypeError(`'${key}' is a built-in event type; it can't be changed`, 409)
  await audit(q, actor, 'event_type.registered', key, `Registered event type ${key} (${label})`, { label, category })
  return rows[0]
}

/** Change a custom type's label, category and/or active flag. The key never changes. */
export async function updateEventType(
  q: Queryable,
  actor: string,
  key: string,
  patch: { label?: unknown; category?: unknown; active?: unknown },
): Promise<EventTypeRow> {
  const { rows: cur } = await q.query<EventTypeRow>(`select ${COLS} from lp.event_types where key = $1 for update`, [key])
  const old = cur[0]
  if (!old) throw new EventTypeError(`no event type '${key}'`, 404)
  if (isBuiltInEventType(old)) throw new EventTypeError(`'${key}' is a built-in event type (source ${old.source}); it can't be changed`, 409)
  const label = patch.label === undefined ? old.label : cleanLabel(patch.label)
  const category = patch.category === undefined ? old.category : cleanCategory(patch.category)
  let active = old.active
  if (patch.active !== undefined) {
    if (typeof patch.active !== 'boolean') throw new EventTypeError('active must be true or false')
    active = patch.active
  }
  const { rows } = await q.query<EventTypeRow>(`update lp.event_types set label = $2, category = $3, active = $4 where key = $1 returning ${COLS}`, [key, label, category, active])
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  if (label !== old.label) changes.label = { from: old.label, to: label }
  if (category !== old.category) changes.category = { from: old.category, to: category }
  if (active !== old.active) changes.active = { from: old.active, to: active }
  if (Object.keys(changes).length) {
    const what = changes.active ? (active ? 'Activated' : 'Deactivated') : 'Updated'
    await audit(q, actor, 'event_type.updated', key, `${what} event type ${key}`, changes)
  }
  return rows[0]
}

export type EventTypeListRow = EventTypeRow & { created_by_name: string | null; stored_count: number }

/** Every registered type with its stored lp.lead_events count (index-only on lead_events_type_idx). */
export async function listEventTypesWithCounts(q: Queryable): Promise<EventTypeListRow[]> {
  const { rows } = await q.query<EventTypeListRow>(
    `select t.key, t.label, t.category, t.source, t.props_schema, t.active, t.created_by, t.created_at,
            a.display_name as created_by_name, coalesce(c.n, 0)::int as stored_count
       from lp.event_types t
       left join lp.actors a on a.id = t.created_by
       left join (select type, count(*)::int as n from lp.lead_events group by type) c on c.type = t.key
      order by t.category, t.key`,
  )
  return rows
}
