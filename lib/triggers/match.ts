/**
 * Plan 3.2: decide when a saved trigger fires, and write lp.trigger_fires.
 *
 * Event and segment_joined / segment_left fire from emitLeadEvents (same
 * transaction). Field changes fire from the lead editors. Date, schedule and
 * dynamic segment membership are evaluated by scanDueTriggers, which the
 * trigger_scan job calls every 15 minutes. API triggers fire from a token.
 *
 * No journey table is touched. 3.1's runner reads lp.trigger_fires.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Db, Queryable } from '@/lib/db/types'
import { isUndefinedTable } from '@/lib/db/errors'
import { CronError, nextRun } from '@/lib/jobs/cron'
import { normalizeEmail } from '@/lib/leads/normalize'
import { compileSegment, matchingIds } from '@/lib/segments/compile'

export const TRIGGER_KINDS = ['event', 'segment_entry', 'segment_exit', 'field_change', 'date', 'schedule', 'api', 'delayed'] as const
export type TriggerKind = (typeof TRIGGER_KINDS)[number]

const COMPANY_DATE_COLS = ['created_at', 'updated_at', 'last_researched_at'] as const
const CONTACT_DATE_COLS = ['created_at', 'updated_at', 'verified_at'] as const
const FIELD_RE = /^[a-z][a-z0-9_]{0,62}$/
const EVENT_RE = /^[a-z][a-z0-9_]{0,63}$/
const CUSTOM_FIELD_RE = /^custom\.([a-z][a-z0-9_]{0,62})$/
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/

export class TriggerError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
    this.name = 'TriggerError'
  }
}

export interface EmittedEvent {
  id: number
  type: string
  company_id: number | null
  contact_id: number | null
  campaign_id: number | null
  props: Record<string, unknown>
}

export interface FieldChange {
  entity: 'company' | 'contact'
  id: number
  field: string
  from: string | null
  to: string | null
  company_id: number | null
  contact_id: number | null
}

interface TriggerRow {
  id: number
  kind: TriggerKind
  campaign_id: number | null
  config: Record<string, unknown>
  created_at?: string
}

function cfg(row: { config: unknown }): Record<string, unknown> {
  return row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? row.config as Record<string, unknown> : {}
}

function memberKey(companyId: number | null, contactId: number | null): string | null {
  if (contactId != null) return `contact:${contactId}`
  if (companyId != null) return `company:${companyId}`
  return null
}

export function hashTriggerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newTriggerToken(): string {
  return `trg_${randomBytes(24).toString('hex')}`
}

function tokenMatches(given: string, storedHash: string): boolean {
  const got = new Uint8Array(createHash('sha256').update(given).digest())
  const raw = Buffer.from(storedHash, 'hex')
  if (raw.length !== got.length) return false
  return timingSafeEqual(got, new Uint8Array(raw))
}

function validTz(tz: string): boolean {
  if (!TZ_RE.test(tz)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function validateTriggerConfig(kind: TriggerKind, raw: unknown): Record<string, unknown> {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  if (kind === 'event') {
    const eventType = typeof c.event_type === 'string' ? c.event_type.trim() : ''
    if (!eventType || eventType.length > 64) throw new TriggerError('event triggers need config.event_type')
    return { event_type: eventType }
  }
  if (kind === 'segment_entry' || kind === 'segment_exit') {
    const segmentId = Number(c.segment_id)
    if (!Number.isInteger(segmentId) || segmentId <= 0) throw new TriggerError('segment triggers need a positive config.segment_id')
    return { segment_id: segmentId }
  }
  if (kind === 'field_change') {
    const entity = c.entity === 'contact' ? 'contact' : c.entity === 'company' ? 'company' : ''
    if (!entity) throw new TriggerError('field_change triggers need config.entity "company" or "contact"')
    const field = typeof c.field === 'string' ? c.field.trim() : ''
    if (!FIELD_RE.test(field) && !CUSTOM_FIELD_RE.test(field)) throw new TriggerError('field_change config.field must be a column or custom.<key>')
    const out: Record<string, unknown> = { entity, field }
    if (c.to !== undefined && c.to !== null) out.to = String(c.to)
    return out
  }
  if (kind === 'date') {
    const entity = c.entity === 'contact' ? 'contact' : c.entity === 'company' ? 'company' : ''
    if (!entity) throw new TriggerError('date triggers need config.entity "company" or "contact"')
    const field = typeof c.field === 'string' ? c.field.trim() : ''
    const builtin = entity === 'company' ? COMPANY_DATE_COLS : CONTACT_DATE_COLS
    if (!(builtin as readonly string[]).includes(field) && !CUSTOM_FIELD_RE.test(field)) {
      throw new TriggerError(`date triggers on ${entity} use ${builtin.join(', ')} or custom.<key>`)
    }
    const offset = c.offset_days == null ? 0 : Number(c.offset_days)
    if (!Number.isInteger(offset) || offset < -365 || offset > 365) throw new TriggerError('date config.offset_days must be an integer from -365 to 365')
    const timezone = typeof c.timezone === 'string' && c.timezone.trim() ? c.timezone.trim() : 'America/New_York'
    if (!validTz(timezone)) throw new TriggerError('date config.timezone is not a known time zone')
    return { entity, field, offset_days: offset, timezone }
  }
  if (kind === 'schedule') {
    const cron = typeof c.cron === 'string' ? c.cron.trim() : ''
    const timezone = typeof c.timezone === 'string' && c.timezone.trim() ? c.timezone.trim() : 'America/New_York'
    if (!validTz(timezone)) throw new TriggerError('schedule config.timezone is not a known time zone')
    try {
      nextRun(cron, new Date(), timezone)
    } catch (e) {
      if (e instanceof CronError) throw new TriggerError(`schedule config.cron: ${e.message}`)
      throw e
    }
    return { cron, timezone }
  }
  if (kind === 'delayed') {
    const after = typeof c.after_event === 'string' ? c.after_event.trim() : ''
    if (!EVENT_RE.test(after)) throw new TriggerError('delayed triggers need config.after_event')
    const days = Number(c.days)
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new TriggerError('delayed config.days must be an integer from 1 to 365')
    const unless = unlessEvents(c)
    if (!unless.length) throw new TriggerError('delayed triggers need config.unless_event (the Y that cancels them)')
    if (unless.includes(after)) throw new TriggerError(`delayed config.unless_event cannot be the same event as after_event ("${after}"): it would cancel itself`)
    return { after_event: after, days, unless_events: unless }
  }
  return {}
}

function unlessEvents(c: Record<string, unknown>): string[] {
  const raw = Array.isArray(c.unless_events) ? c.unless_events : c.unless_event != null ? [c.unless_event] : []
  return [...new Set(raw.map((x) => String(x).trim()).filter((s) => EVENT_RE.test(s)))]
}

async function campaignOk(
  q: Queryable,
  campaignId: number | null,
  lead: { company_id: number | null; contact_id: number | null; campaign_id?: number | null },
): Promise<boolean> {
  if (campaignId == null) return true
  if (lead.campaign_id != null && lead.campaign_id === campaignId) return true
  if (lead.campaign_id != null && lead.campaign_id !== campaignId) return false
  const companyId = lead.company_id ?? (lead.contact_id == null ? null : (await q.query<{ company_id: number | null }>(
    'select company_id from lp.contacts where id = $1',
    [lead.contact_id],
  )).rows[0]?.company_id ?? null)
  if (companyId == null) return false
  const { rows } = await q.query(
    'select 1 from lp.campaign_leads where campaign_id = $1 and company_id = $2',
    [campaignId, companyId],
  )
  return rows.length > 0
}

async function insertFire(
  q: Queryable,
  triggerId: number,
  lead: { company_id: number | null; contact_id: number | null },
  payload: Record<string, unknown>,
  dedupeKey: string | null,
): Promise<boolean> {
  const { rows } = await q.query<{ id: number }>(
    `insert into lp.trigger_fires (trigger_id, company_id, contact_id, payload, dedupe_key)
     values ($1, $2, $3, $4, $5)
     on conflict (dedupe_key) where dedupe_key is not null do nothing
     returning id`,
    [triggerId, lead.company_id, lead.contact_id, JSON.stringify(payload), dedupeKey],
  )
  return Boolean(rows[0])
}

async function syncWatch(
  q: Queryable,
  trigger: TriggerRow,
  key: string,
  inside: boolean,
  lead: { company_id: number | null; contact_id: number | null },
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (inside) {
    const { rows } = await q.query(
      `insert into lp.trigger_watch (trigger_id, member_key) values ($1, $2)
       on conflict do nothing returning trigger_id`,
      [trigger.id, key],
    )
    if (!rows[0] || trigger.kind !== 'segment_entry') return false
    return insertFire(q, trigger.id, lead, payload, `seg-enter:${trigger.id}:${key}:${Date.now()}`)
  }
  const { rows } = await q.query(
    'delete from lp.trigger_watch where trigger_id = $1 and member_key = $2 returning trigger_id',
    [trigger.id, key],
  )
  if (!rows[0] || trigger.kind !== 'segment_exit') return false
  return insertFire(q, trigger.id, lead, payload, `seg-exit:${trigger.id}:${key}:${Date.now()}`)
}

function segIdOf(props: Record<string, unknown>): number | null {
  const n = Number(props.segment_id)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Fire event triggers, and advance segment watches, for events just inserted. */
export async function matchEmittedEvents(q: Queryable, events: EmittedEvent[]): Promise<number> {
  if (!events.length) return 0
  const types = [...new Set(events.map((e) => e.type))]
  const eventTriggers = (await q.query<TriggerRow>(
    `select id, kind, campaign_id, config from lp.triggers
      where enabled and kind = 'event' and config->>'event_type' = any($1::text[])`,
    [types],
  )).rows.map((r) => ({ ...r, config: cfg(r) }))
  const segTriggers = types.some((t) => t === 'segment_joined' || t === 'segment_left')
    ? (await q.query<TriggerRow>(
      `select id, kind, campaign_id, config from lp.triggers where enabled and kind in ('segment_entry', 'segment_exit')`,
    )).rows.map((r) => ({ ...r, config: cfg(r) }))
    : []
  const delayTriggers = await loadDelayTriggers(q, types)
  let fired = 0
  // In order, one event at a time: arm any delay this event starts, then cancel
  // any pending delay this event answers. A Y that comes before an X in the
  // batch must never cancel the delay the X is about to start.
  for (const e of events) {
    await armDelayed(q, delayTriggers, e)
    await cancelDelayed(q, e)
    for (const t of eventTriggers) {
      if (t.config.event_type !== e.type) continue
      if (!(await campaignOk(q, t.campaign_id, e))) continue
      if (await insertFire(q, t.id, e, { lead_event_id: e.id, type: e.type }, `event:${t.id}:${e.id}`)) fired++
    }
    const segId = segIdOf(e.props)
    const entering = e.type === 'segment_joined'
    const leaving = e.type === 'segment_left'
    if (segId == null || (!entering && !leaving)) continue
    const key = memberKey(e.company_id, e.contact_id)
    if (!key) continue
    for (const t of segTriggers) {
      if (Number(t.config.segment_id) !== segId) continue
      if (!(await campaignOk(q, t.campaign_id, e))) continue
      if (await syncWatch(q, t, key, entering, e, { segment_id: segId, type: e.type })) fired++
    }
  }
  return fired
}

/** Fire field_change triggers for one lead field that just changed. */
export async function onFieldChanged(q: Queryable, change: FieldChange): Promise<number> {
  const triggers = (await q.query<TriggerRow>(
    `select id, kind, campaign_id, config from lp.triggers
      where enabled and kind = 'field_change'
        and config->>'entity' = $1 and config->>'field' = $2`,
    [change.entity, change.field],
  )).rows.map((r) => ({ ...r, config: cfg(r) }))
  let fired = 0
  for (const t of triggers) {
    if (t.config.to !== undefined && String(t.config.to) !== (change.to ?? '')) continue
    if (!(await campaignOk(q, t.campaign_id, change))) continue
    if (await insertFire(q, t.id, change, {
      entity: change.entity, id: change.id, field: change.field, from: change.from, to: change.to,
    }, null)) fired++
  }
  return fired
}

export async function safeMatchEmitted(q: Queryable, events: EmittedEvent[]): Promise<void> {
  try {
    await matchEmittedEvents(q, events)
  } catch (e) {
    if (!isUndefinedTable(e)) throw e
  }
}

export async function safeOnFieldChanged(q: Queryable, change: FieldChange): Promise<void> {
  try {
    await onFieldChanged(q, change)
  } catch (e) {
    if (!isUndefinedTable(e)) throw e
  }
}

async function segmentMemberIds(q: Queryable, segmentId: number): Promise<{ entity: 'company' | 'contact'; ids: number[] } | null> {
  const { rows } = await q.query<{ entity: string; kind: string; definition: unknown }>(
    'select entity, kind, definition from lp.segments where id = $1 and archived_at is null',
    [segmentId],
  )
  const seg = rows[0]
  if (!seg || (seg.entity !== 'company' && seg.entity !== 'contact')) return null
  if (seg.kind === 'static') {
    const col = seg.entity === 'company' ? 'company_id' : 'contact_id'
    const members = await q.query<{ id: number }>(
      `select ${col} as id from lp.segment_members where segment_id = $1 and ${col} is not null`,
      [segmentId],
    )
    return { entity: seg.entity, ids: members.rows.map((r) => r.id) }
  }
  const compiled = await compileSegment(q, seg.definition)
  const ids: number[] = []
  let offset = 0
  for (;;) {
    const page = await matchingIds(q, compiled, { limit: 5000, offset })
    ids.push(...page)
    if (page.length < 5000 || offset >= 50000) break
    offset += 5000
  }
  return { entity: seg.entity, ids }
}

async function scanSegments(q: Queryable): Promise<number> {
  const triggers = (await q.query<TriggerRow>(
    `select id, kind, campaign_id, config from lp.triggers where enabled and kind in ('segment_entry', 'segment_exit')`,
  )).rows.map((r) => ({ ...r, config: cfg(r) }))
  let fired = 0
  for (const t of triggers) {
    const segmentId = Number(t.config.segment_id)
    if (!Number.isInteger(segmentId) || segmentId <= 0) continue
    const members = await segmentMemberIds(q, segmentId)
    if (!members) continue
    const current = new Set(members.ids.map((id) => `${members.entity}:${id}`))
    const watched = new Set((await q.query<{ member_key: string }>(
      'select member_key from lp.trigger_watch where trigger_id = $1',
      [t.id],
    )).rows.map((r) => r.member_key))
    for (const key of current) {
      if (watched.has(key)) continue
      const id = Number(key.split(':')[1])
      const lead = members.entity === 'company'
        ? { company_id: id, contact_id: null }
        : { company_id: null, contact_id: id }
      if (!(await campaignOk(q, t.campaign_id, lead))) continue
      if (await syncWatch(q, t, key, true, lead, { segment_id: segmentId, via: 'scan' })) fired++
    }
    for (const key of watched) {
      if (current.has(key)) continue
      const id = Number(key.split(':')[1])
      const lead = key.startsWith('contact:')
        ? { company_id: null, contact_id: id }
        : { company_id: id, contact_id: null }
      if (await syncWatch(q, t, key, false, lead, { segment_id: segmentId, via: 'scan' })) fired++
    }
  }
  return fired
}

function localDate(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

async function scanDates(q: Queryable, now: Date): Promise<number> {
  const triggers = (await q.query<TriggerRow>(
    `select id, kind, campaign_id, config from lp.triggers where enabled and kind = 'date'`,
  )).rows.map((r) => ({ ...r, config: cfg(r) }))
  let fired = 0
  for (const t of triggers) {
    const entity = t.config.entity === 'contact' ? 'contact' : 'company'
    const field = String(t.config.field ?? '')
    const offset = Number(t.config.offset_days ?? 0)
    const timezone = typeof t.config.timezone === 'string' ? t.config.timezone : 'America/New_York'
    const today = localDate(now, timezone)
    const builtin = entity === 'company' ? COMPANY_DATE_COLS : CONTACT_DATE_COLS
    let rows: { id: number; company_id: number | null }[] = []
    if ((builtin as readonly string[]).includes(field)) {
      const table = entity === 'company' ? 'lp.companies' : 'lp.contacts'
      const companyCol = entity === 'company' ? 'id' : 'company_id'
      rows = (await q.query<{ id: number; company_id: number | null }>(
        `select id, ${companyCol} as company_id from ${table}
          where ${field} is not null
            and ((${field} at time zone $1)::date + $2::int) = $3::date`,
        [timezone, offset, today],
      )).rows
    } else {
      const m = CUSTOM_FIELD_RE.exec(field)
      if (!m) continue
      const key = m[1]
      const def = await q.query(
        `select 1 from lp.field_defs where entity = $1 and key = $2 and type = 'date' and archived_at is null`,
        [entity, key],
      )
      if (!def.rows[0]) continue
      const table = entity === 'company' ? 'lp.companies' : 'lp.contacts'
      const companyCol = entity === 'company' ? 'id' : 'company_id'
      rows = (await q.query<{ id: number; company_id: number | null }>(
        `select id, ${companyCol} as company_id from ${table}
          where custom->>$1 ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            and ((custom->>$1)::date + $2::int) = $3::date`,
        [key, offset, today],
      )).rows
    }
    for (const row of rows) {
      const lead = entity === 'company'
        ? { company_id: row.id, contact_id: null }
        : { company_id: row.company_id, contact_id: row.id }
      if (!(await campaignOk(q, t.campaign_id, lead))) continue
      const key = memberKey(lead.company_id, lead.contact_id)
      if (await insertFire(q, t.id, lead, { field, offset_days: offset, on: today }, `date:${t.id}:${key}:${today}`)) fired++
    }
  }
  return fired
}

async function scanSchedules(q: Queryable, now: Date): Promise<number> {
  const triggers = (await q.query<TriggerRow & { created_at: string }>(
    `select id, kind, campaign_id, config, created_at from lp.triggers where enabled and kind = 'schedule'`,
  )).rows.map((r) => ({ ...r, config: cfg(r) }))
  let fired = 0
  for (const t of triggers) {
    const cron = String(t.config.cron ?? '')
    const timezone = typeof t.config.timezone === 'string' ? t.config.timezone : 'America/New_York'
    const last = await q.query<{ fired_at: string }>(
      'select fired_at from lp.trigger_fires where trigger_id = $1 order by fired_at desc limit 1',
      [t.id],
    )
    const from = last.rows[0] ? new Date(last.rows[0].fired_at) : new Date(t.created_at)
    let slot: Date
    try {
      slot = nextRun(cron, from, timezone)
    } catch {
      continue
    }
    if (slot.getTime() > now.getTime()) continue
    if (await insertFire(q, t.id, { company_id: null, contact_id: null }, {
      cron, timezone, slot: slot.toISOString(), campaign_id: t.campaign_id,
    }, `sched:${t.id}:${slot.toISOString()}`)) fired++
  }
  return fired
}

/** Date, schedule, segment entry/exit, and delayed triggers that are due. Called by the trigger_scan job. */
export async function scanDueTriggers(q: Queryable, now = new Date()): Promise<{ segment: number; date: number; schedule: number; delayed: number }> {
  const segment = await scanSegments(q)
  const date = await scanDates(q, now)
  const schedule = await scanSchedules(q, now)
  const delayed = await scanDelays(q, now)
  return { segment, date, schedule, delayed }
}

/**
 * Delayed triggers (plan 3.3).
 *
 * House rule: timing windows use lp.lead_events.occurred_at (when it happened),
 * never recorded_at (when we stored it), so a backfilled X starts its N-day
 * clock when X happened. A pending delay covers [source_at, due_at], where
 * source_at is X's occurred_at and due_at = source_at + N days; a Y cancels it
 * only if Y's occurred_at falls inside that window.
 *
 * Identity: a delay armed for a contact is answered only by a Y for that same
 * contact. A company-level delay (no contact) is answered by a Y at that
 * company, whichever contact it names. Never the other way round.
 */
interface DelayTriggerRow {
  id: number
  campaign_id: number | null
  config: Record<string, unknown>
}

async function loadDelayTriggers(q: Queryable, types: string[]): Promise<DelayTriggerRow[]> {
  try {
    return (await q.query<TriggerRow>(
      `select id, kind, campaign_id, config from lp.triggers
        where enabled and kind = 'delayed' and config->>'after_event' = any($1::text[])`,
      [types],
    )).rows.map((r) => ({ id: r.id, campaign_id: r.campaign_id, config: cfg(r) }))
  } catch (e) {
    if (!isUndefinedTable(e)) throw e
    return []
  }
}

async function armDelayed(q: Queryable, triggers: DelayTriggerRow[], e: EmittedEvent): Promise<void> {
  if (!triggers.length) return
  if (e.company_id == null && e.contact_id == null) return
  try {
    for (const t of triggers) {
      if (t.config.after_event !== e.type) continue
      if (!(await campaignOk(q, t.campaign_id, e))) continue
      const unless = Array.isArray(t.config.unless_events) ? t.config.unless_events : []
      await q.query(
        `insert into lp.trigger_delays (trigger_id, company_id, contact_id, source_event_id, source_at, due_at, unless_events)
         select $1, $2, $3, le.id, le.occurred_at, le.occurred_at + make_interval(days => $5::int), $6::text[]
           from lp.lead_events le where le.id = $4
         on conflict (trigger_id, source_event_id) where source_event_id is not null do nothing`,
        [t.id, e.company_id, e.contact_id, e.id, Number(t.config.days), unless],
      )
    }
  } catch (err) {
    if (!isUndefinedTable(err)) throw err
  }
}

/**
 * Cancel the pending delays this event answers. Only rows that are not yet due:
 * a past-due row belongs to scanDelays, which fires or cancels it with the full
 * [source_at, due_at] check.
 */
async function cancelDelayed(q: Queryable, e: EmittedEvent): Promise<void> {
  if (e.company_id == null && e.contact_id == null) return
  try {
    await q.query(
      `update lp.trigger_delays d
          set status = 'cancelled'
         from lp.lead_events le
        where le.id = $1
          and d.status = 'pending'
          and d.due_at > now()
          and le.type = any(d.unless_events)
          and le.occurred_at >= coalesce(d.source_at, d.created_at)
          and le.occurred_at <= d.due_at
          and (
            (d.contact_id is not null and d.contact_id = $3::bigint)
            or (d.contact_id is null and d.company_id is not null and d.company_id = $2::bigint)
          )`,
      [e.id, e.company_id, e.contact_id],
    )
  } catch (err) {
    if (!isUndefinedTable(err)) throw err
  }
}

/** Run fn in one transaction when q can open one (a Db), else in the caller's own. */
function inTx<T>(q: Queryable, fn: (t: Queryable) => Promise<T>): Promise<T> {
  const maybe = q as Partial<Db>
  return typeof maybe.tx === 'function' ? maybe.tx(fn) : fn(q)
}

/**
 * Fire or cancel delays that are due.
 *
 * - A pending delay whose trigger is disabled (or no longer a delayed trigger)
 *   is cancelled, not fired and not left to fire later. Cancelling is the
 *   safer choice: re-enabling a trigger never releases a stale burst of fires.
 *   Only delays that are still pending when the trigger is disabled are lost;
 *   re-enable and re-arm by a new X.
 * - The due rows are locked with FOR UPDATE SKIP LOCKED inside one
 *   transaction, so two concurrent trigger_scan runs never take the same row.
 *   trigger_fires.dedupe_key ('delay:<id>', unique) is the second guard.
 */
async function scanDelays(q: Queryable, now: Date): Promise<number> {
  try {
    return await inTx(q, async (t) => {
      await t.query(
        `update lp.trigger_delays d set status = 'cancelled'
           from lp.triggers tr
          where tr.id = d.trigger_id and d.status = 'pending'
            and (not tr.enabled or tr.kind <> 'delayed')`,
      )
      const due = await t.query<{
        id: number
        trigger_id: number
        company_id: number | null
        contact_id: number | null
        unless_events: string[]
      }>(
        `select d.id, d.trigger_id, d.company_id, d.contact_id, d.unless_events
           from lp.trigger_delays d
           join lp.triggers tr on tr.id = d.trigger_id and tr.enabled and tr.kind = 'delayed'
          where d.status = 'pending' and d.due_at <= $1
          order by d.id
          limit 200
            for update of d skip locked`,
        [now.toISOString()],
      )
      let fired = 0
      for (const row of due.rows) {
        const hit = await t.query(
          `select 1
             from lp.trigger_delays d
             join lp.lead_events le
               on le.type = any(d.unless_events)
              and le.occurred_at >= coalesce(d.source_at, d.created_at)
              and le.occurred_at <= d.due_at
              and (
                (d.contact_id is not null and le.contact_id = d.contact_id)
                or (d.contact_id is null and d.company_id is not null and le.company_id = d.company_id)
              )
            where d.id = $1
            limit 1`,
          [row.id],
        )
        if (hit.rows.length) {
          await t.query(`update lp.trigger_delays set status = 'cancelled' where id = $1 and status = 'pending'`, [row.id])
          continue
        }
        const wrote = await insertFire(t, row.trigger_id, row, {
          delay_id: row.id, cancel_on: row.unless_events,
        }, `delay:${row.id}`)
        await t.query(`update lp.trigger_delays set status = 'fired' where id = $1 and status = 'pending'`, [row.id])
        if (wrote) fired++
      }
      return fired
    })
  } catch (e) {
    if (!isUndefinedTable(e)) throw e
    return 0
  }
}

export async function fireApiTrigger(
  q: Queryable,
  input: { token: string; company_id?: number | null; contact_id?: number | null; email?: string | null; payload?: Record<string, unknown>; dedupe_key?: string | null },
): Promise<{ fired: boolean; trigger_id: number; company_id: number | null; contact_id: number | null }> {
  const token = input.token.trim()
  if (!token) throw new TriggerError('token is required', 401)
  const triggers = (await q.query<{ id: number; campaign_id: number | null; token_hash: string | null }>(
    `select id, campaign_id, token_hash from lp.triggers where enabled and kind = 'api' and token_hash is not null`,
  )).rows
  const match = triggers.find((t) => t.token_hash && tokenMatches(token, t.token_hash))
  if (!match) throw new TriggerError('unknown trigger token', 401)
  let companyId = input.company_id ?? null
  let contactId = input.contact_id ?? null
  const email = normalizeEmail(input.email ?? null)
  if (companyId == null && contactId == null && email) {
    const found = await q.query<{ id: number; company_id: number | null }>(
      'select id, company_id from lp.contacts where email_norm = $1',
      [email],
    )
    contactId = found.rows[0]?.id ?? null
    companyId = found.rows[0]?.company_id ?? null
  }
  if (companyId == null && contactId == null) throw new TriggerError('give company_id, contact_id or email')
  const lead = { company_id: companyId, contact_id: contactId }
  if (!(await campaignOk(q, match.campaign_id, lead))) throw new TriggerError('that lead is not in this trigger\'s campaign', 403)
  const dedupe = input.dedupe_key?.trim() || null
  const fired = await insertFire(q, match.id, lead, input.payload ?? {}, dedupe)
  return { fired, trigger_id: match.id, company_id: companyId, contact_id: contactId }
}
