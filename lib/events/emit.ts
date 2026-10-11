/**
 * The lead event stream (lp.lead_events): one append-only row per thing that
 * happened to a lead. Every writer in the app calls emitLeadEvent /
 * emitLeadEvents instead of inserting directly, so the shape stays consistent
 * (company/contact resolution, dedupe, type validation) in one place.
 *
 * lp.events stays the human-readable activity/audit feed (logEvent in
 * lib/ops/events.ts); this is the structured stream segments, journeys,
 * scoring and the Ops track_event API all read.
 */
import type { Queryable } from '@/lib/db/types'
import { normalizeEmail } from '@/lib/leads/normalize'

export class EventError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
    this.name = 'EventError'
  }
}

export interface EmitLeadEventInput {
  type: string
  company_id?: number | null
  contact_id?: number | null
  /** Used to resolve company/contact when only an email is given; always stored as email_norm. */
  email?: string | null
  campaign_id?: number | null
  instantly_campaign_id?: string | null
  step?: number | null
  /** instantly_webhook, ops_api, dashboard, runner, backfill, agent id, ... */
  source: string
  actor?: string | null
  props?: Record<string, unknown>
  occurred_at?: Date | string | null
  dedupe_key?: string | null
}

export interface EmitResult {
  inserted: boolean
  id: number | null
  type: string
  company_id: number | null
  contact_id: number | null
}

interface Resolved {
  company_id: number | null
  contact_id: number | null
  email_norm: string | null
}

function cleanType(type: string): string {
  const t = (type ?? '').trim()
  if (!t) throw new EventError('type is required')
  return t
}

async function knownTypes(q: Queryable, types: string[]): Promise<Set<string>> {
  if (!types.length) return new Set()
  const { rows } = await q.query<{ key: string }>(`select key from lp.event_types where key = any($1::text[]) and active`, [types])
  return new Set(rows.map((r) => r.key))
}

async function resolveByEmails(q: Queryable, emails: string[]): Promise<Map<string, { id: number; company_id: number | null }>> {
  const out = new Map<string, { id: number; company_id: number | null }>()
  if (!emails.length) return out
  const { rows } = await q.query<{ id: number; company_id: number | null; email_norm: string }>(
    `select id, company_id, email_norm from lp.contacts where email_norm = any($1::text[])`,
    [emails],
  )
  for (const r of rows) out.set(r.email_norm, { id: r.id, company_id: r.company_id })
  return out
}

function resolve(input: EmitLeadEventInput, byEmail: Map<string, { id: number; company_id: number | null }>): Resolved {
  const email = normalizeEmail(input.email ?? null)
  let companyId = input.company_id ?? null
  let contactId = input.contact_id ?? null
  if (companyId == null && contactId == null && email && byEmail.has(email)) {
    const c = byEmail.get(email)!
    contactId = c.id
    companyId = c.company_id
  }
  return { company_id: companyId, contact_id: contactId, email_norm: email }
}

const COLS = [
  'occurred_at', 'type', 'company_id', 'contact_id', 'email_norm', 'campaign_id',
  'instantly_campaign_id', 'step', 'source', 'actor', 'props', 'dedupe_key',
] as const

function row(input: EmitLeadEventInput, type: string, r: Resolved): unknown[] {
  return [
    input.occurred_at ? new Date(input.occurred_at) : new Date(),
    type,
    r.company_id,
    r.contact_id,
    r.email_norm,
    input.campaign_id ?? null,
    input.instantly_campaign_id ?? null,
    input.step ?? null,
    input.source,
    input.actor ?? null,
    JSON.stringify(input.props ?? {}),
    input.dedupe_key?.trim() || null,
  ]
}

/**
 * Record one lead event. Works inside an existing transaction (takes a
 * Queryable, not a Db) so callers can emit in the same tx as their own write.
 * Unknown type -> EventError. Duplicate dedupe_key -> {inserted:false}, not an
 * error (ON CONFLICT DO NOTHING): a retried delivery is a no-op, not a failure.
 */
export async function emitLeadEvent(q: Queryable, input: EmitLeadEventInput): Promise<EmitResult> {
  const type = cleanType(input.type)
  const known = await knownTypes(q, [type])
  if (!known.has(type)) throw new EventError(`unknown event type '${type}' — register it first with register_event_type`)
  const email = normalizeEmail(input.email ?? null)
  const byEmail = await resolveByEmails(q, input.company_id == null && input.contact_id == null && email ? [email] : [])
  const r = resolve(input, byEmail)
  const { rows } = await q.query<{ id: number }>(
    `insert into lp.lead_events (${COLS.join(', ')})
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (dedupe_key) where dedupe_key is not null do nothing
     returning id`,
    row(input, type, r),
  )
  if (!rows[0]) return { inserted: false, id: null, type, company_id: r.company_id, contact_id: r.contact_id }
  return { inserted: true, id: rows[0].id, type, company_id: r.company_id, contact_id: r.contact_id }
}

/**
 * Record a batch of lead events as one multi-row insert. Any unknown type
 * fails the whole batch (EventError, naming every unknown type) before
 * anything is written. Duplicates (by dedupe_key) are skipped individually,
 * same as emitLeadEvent.
 */
export async function emitLeadEvents(q: Queryable, inputs: EmitLeadEventInput[]): Promise<EmitResult[]> {
  if (!inputs.length) return []
  const types = [...new Set(inputs.map((i) => cleanType(i.type)))]
  const known = await knownTypes(q, types)
  const missing = types.filter((t) => !known.has(t))
  if (missing.length) throw new EventError(`unknown event type(s): ${missing.join(', ')} — register them first with register_event_type`)

  const emailsToResolve = [
    ...new Set(
      inputs
        .filter((i) => i.company_id == null && i.contact_id == null)
        .map((i) => normalizeEmail(i.email ?? null))
        .filter((e): e is string => Boolean(e)),
    ),
  ]
  const byEmail = await resolveByEmails(q, emailsToResolve)
  const prepared = inputs.map((i) => ({ input: i, type: cleanType(i.type), resolved: resolve(i, byEmail) }))

  const values: unknown[] = []
  const tuples = prepared.map((p, idx) => {
    const base = idx * COLS.length
    values.push(...row(p.input, p.type, p.resolved))
    return `(${COLS.map((_, i) => `$${base + i + 1}`).join(', ')})`
  })
  const { rows } = await q.query<{ id: number; dedupe_key: string | null }>(
    `insert into lp.lead_events (${COLS.join(', ')}) values ${tuples.join(', ')}
     on conflict (dedupe_key) where dedupe_key is not null do nothing
     returning id, dedupe_key`,
    values,
  )

  // Postgres preserves VALUES row order in RETURNING for a single INSERT; walk
  // both lists in lockstep, consuming a returned row only when its dedupe_key
  // (null, or a specific key) matches the prepared row we expect next.
  let ptr = 0
  return prepared.map((p) => {
    const dk = p.input.dedupe_key?.trim() || null
    const r = rows[ptr]
    if (r && (dk === null ? r.dedupe_key === null : r.dedupe_key === dk)) {
      ptr++
      return { inserted: true, id: r.id, type: p.type, company_id: p.resolved.company_id, contact_id: p.resolved.contact_id }
    }
    return { inserted: false, id: null, type: p.type, company_id: p.resolved.company_id, contact_id: p.resolved.contact_id }
  })
}
