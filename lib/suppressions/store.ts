/**
 * The suppression list (item 1.8): emails and whole domains that must never be
 * pushed to a sender (Instantly today, Warmbly later). Schema is 0019_suppressions.sql
 * (PR #63): lp.suppressions, lp.contacts.subscription_status, lp.consent_log and the
 * SQL helper lp.is_suppressed(email, campaign_id).
 *
 * Enforcement lives in lib/instantly/add-leads.ts (buildAddPreview excludes before
 * the approval request; recheckReady excludes again right before the actual send,
 * since state can change between approval and send) -- this module is the store,
 * not the gate.
 *
 * Every add/lift writes an lp.status_history row (entity_type 'suppression') and,
 * when the email or domain matches a known contact, an lp.lead_events 'suppressed'
 * row -- written with plain SQL here (lib/events/emit.ts is a sibling module built
 * in parallel; this file does not import it, the same way the Instantly webhook
 * does not import this file and writes lp.suppressions with plain SQL instead).
 */
import type { Db, Queryable } from '../db/types.ts'
import { csvObjects } from '../leads/csv.ts'

export type SuppressionReason =
  | 'unsubscribed'
  | 'bounced'
  | 'complained'
  | 'do_not_contact'
  | 'competitor'
  | 'customer'
  | 'manual'
  | 'legal'
  | 'other'

export const REASONS: SuppressionReason[] = [
  'unsubscribed',
  'bounced',
  'complained',
  'do_not_contact',
  'competitor',
  'customer',
  'manual',
  'legal',
  'other',
]

export const REASON_WORDS: Record<SuppressionReason, string> = {
  unsubscribed: 'Unsubscribed',
  bounced: 'Bounced',
  complained: 'Complained',
  do_not_contact: 'Do not contact',
  competitor: 'Competitor',
  customer: 'Customer',
  manual: 'Manual',
  legal: 'Legal',
  other: 'Other',
}

export class SuppressionError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'SuppressionError'
    this.status = status
  }
}

export interface SuppressionRow {
  id: number
  email_norm: string | null
  domain: string | null
  campaign_id: number | null
  reason: SuppressionReason
  source: string
  note: string | null
  created_by: string | null
  created_at: string
  expires_at: string | null
  lifted_at: string | null
  lifted_by: string | null
}

const ROW_COLS = 'id, email_norm, domain, campaign_id, reason, source, note, created_by, created_at, expires_at, lifted_at, lifted_by'

export function normalizeEmail(v: string): string {
  return v.trim().toLowerCase()
}

export function normalizeDomain(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '')
}

const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOMAINISH = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

function validateReason(r: unknown): SuppressionReason {
  const s = typeof r === 'string' ? r.trim() : ''
  if (!REASONS.includes(s as SuppressionReason)) throw new SuppressionError(`reason must be one of: ${REASONS.join(', ')}`)
  return s as SuppressionReason
}

/** email XOR domain, normalized and validated. Throws SuppressionError otherwise. */
function normalizeTarget(input: { email?: string | null; domain?: string | null }): { email_norm: string | null; domain: string | null } {
  const email = typeof input.email === 'string' ? input.email.trim() : ''
  const domain = typeof input.domain === 'string' ? input.domain.trim() : ''
  if (email && domain) throw new SuppressionError('Give an email or a domain, not both.')
  if (!email && !domain) throw new SuppressionError('Give an email or a domain.')
  if (email) {
    const email_norm = normalizeEmail(email)
    if (!EMAILISH.test(email_norm)) throw new SuppressionError(`"${email}" is not a valid email address.`)
    return { email_norm, domain: null }
  }
  const d = normalizeDomain(domain)
  if (!DOMAINISH.test(d)) throw new SuppressionError(`"${domain}" is not a valid domain.`)
  return { email_norm: null, domain: d }
}

/** Contacts to log a 'suppressed' lead event against (capped so a common domain can't blow this up). */
async function matchingContacts(q: Queryable, emailNorm: string | null, domain: string | null): Promise<{ id: number; company_id: number; email_norm: string | null }[]> {
  if (emailNorm) {
    const { rows } = await q.query<{ id: number; company_id: number; email_norm: string | null }>(
      'select id, company_id, email_norm from lp.contacts where email_norm = $1',
      [emailNorm],
    )
    return rows
  }
  if (domain) {
    const { rows } = await q.query<{ id: number; company_id: number; email_norm: string | null }>(
      `select id, company_id, email_norm from lp.contacts where email_norm like '%@' || $1 order by id limit 200`,
      [domain],
    )
    return rows
  }
  return []
}

async function emitSuppressedEvents(
  q: Queryable,
  actor: string | null,
  suppressionId: number,
  campaignId: number | null,
  reason: string,
  contacts: { id: number; company_id: number; email_norm: string | null }[],
): Promise<void> {
  for (const c of contacts) {
    await q.query(
      `insert into lp.lead_events (occurred_at, type, company_id, contact_id, email_norm, campaign_id, source, actor, props, dedupe_key)
       values (now(), 'suppressed', $1, $2, $3, $4, 'suppression', $5, $6, $7)
       on conflict do nothing`,
      [c.company_id, c.id, c.email_norm, campaignId, actor, JSON.stringify({ suppression_id: suppressionId, reason }), `suppression:${suppressionId}:${c.id}`],
    )
  }
}

export interface AddSuppressionInput {
  email?: string | null
  domain?: string | null
  campaign_id?: number | null
  reason: string
  source?: string
  note?: string | null
  expires_at?: string | null
}

/**
 * Core logic, for use inside an existing transaction (e.g. the status-sync
 * importer). Idempotent: an existing LIVE row for the same (email|domain,
 * campaign) is returned unchanged, never duplicated or updated.
 */
export async function addSuppressionIn(q: Queryable, actor: string | null, input: AddSuppressionInput): Promise<{ row: SuppressionRow; created: boolean }> {
  const { email_norm, domain } = normalizeTarget(input)
  const reason = validateReason(input.reason)
  const campaignId = input.campaign_id == null ? null : Number(input.campaign_id)
  if (campaignId != null && (!Number.isInteger(campaignId) || campaignId <= 0)) throw new SuppressionError('campaign_id must be a positive integer')
  const note = input.note != null ? String(input.note).slice(0, 1000) : null
  const source = (input.source ?? 'manual').slice(0, 60)
  const expiresAt = input.expires_at ?? null

  const existing = await q.query<SuppressionRow>(
    `select ${ROW_COLS} from lp.suppressions
      where coalesce(email_norm, '') = coalesce($1, '') and coalesce(domain, '') = coalesce($2, '')
        and coalesce(campaign_id, 0) = coalesce($3, 0) and lifted_at is null`,
    [email_norm, domain, campaignId],
  )
  if (existing.rows[0]) return { row: existing.rows[0], created: false }

  const { rows } = await q.query<SuppressionRow>(
    `insert into lp.suppressions (email_norm, domain, campaign_id, reason, source, note, created_by, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${ROW_COLS}`,
    [email_norm, domain, campaignId, reason, source, note, actor, expiresAt],
  )
  const row = rows[0]
  const via: 'ui' | 'ops_api' | 'webhook' | 'runner' | 'import' | 'trigger' =
    source === 'ui' || source === 'manual' ? 'ui' : source === 'import' ? 'import' : source.includes('webhook') ? 'webhook' : 'ops_api'
  await q.query(
    `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via, note)
     values ('suppression', $1, 'created', null, $2, $3, $4, $5)`,
    [row.id, `${email_norm ?? domain} (${reason}${campaignId ? `, campaign ${campaignId}` : ', all campaigns'})`, actor, via, note],
  )
  const contacts = await matchingContacts(q, email_norm, domain)
  if (contacts.length) await emitSuppressedEvents(q, actor, row.id, campaignId, reason, contacts)
  return { row, created: true }
}

export async function addSuppression(db: Db, actor: string, input: AddSuppressionInput): Promise<SuppressionRow> {
  const { row } = await db.tx((q) => addSuppressionIn(q, actor, input), actor)
  return row
}

export interface LiftSuppressionInput {
  id?: number
  email?: string | null
  domain?: string | null
  campaign_id?: number | null
}

export async function liftSuppression(db: Db, actor: string, input: LiftSuppressionInput): Promise<SuppressionRow> {
  return db.tx(async (q) => {
    let row: SuppressionRow | null = null
    if (input.id != null) {
      const { rows } = await q.query<SuppressionRow>(`select ${ROW_COLS} from lp.suppressions where id = $1 and lifted_at is null`, [Number(input.id)])
      row = rows[0] ?? null
    } else {
      const { email_norm, domain } = normalizeTarget(input)
      const campaignId = input.campaign_id == null ? null : Number(input.campaign_id)
      const { rows } = await q.query<SuppressionRow>(
        `select ${ROW_COLS} from lp.suppressions
          where coalesce(email_norm, '') = coalesce($1, '') and coalesce(domain, '') = coalesce($2, '')
            and coalesce(campaign_id, 0) = coalesce($3, 0) and lifted_at is null`,
        [email_norm, domain, campaignId],
      )
      row = rows[0] ?? null
    }
    if (!row) throw new SuppressionError('No live suppression found for that.', 404)
    const { rows } = await q.query<SuppressionRow>(
      `update lp.suppressions set lifted_at = now(), lifted_by = $2 where id = $1 returning ${ROW_COLS}`,
      [row.id, actor],
    )
    await q.query(
      `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via)
       values ('suppression', $1, 'lifted', $2, 'lifted', $3, 'ui')`,
      [row.id, row.reason, actor],
    )
    return rows[0]
  }, actor)
}

export interface ListSuppressionsFilter {
  q?: string | null
  reason?: string | null
  campaign_id?: number | null
  include_lifted?: boolean
  page?: number
}

const PAGE_SIZE = 100

export async function listSuppressions(q: Queryable, f: ListSuppressionsFilter = {}): Promise<{ rows: SuppressionRow[]; total: number; page: number; pages: number }> {
  const where: string[] = []
  const params: unknown[] = []
  if (!f.include_lifted) where.push('lifted_at is null')
  if (f.reason) {
    params.push(f.reason)
    where.push(`reason = $${params.length}`)
  }
  if (f.campaign_id != null) {
    params.push(Number(f.campaign_id))
    where.push(`campaign_id = $${params.length}`)
  }
  if (f.q) {
    params.push(`%${f.q.trim().toLowerCase()}%`)
    where.push(`(coalesce(email_norm, '') ilike $${params.length} or coalesce(domain, '') ilike $${params.length})`)
  }
  const whereSql = where.length ? `where ${where.join(' and ')}` : ''
  const total = Number((await q.query<{ n: number }>(`select count(*)::int as n from lp.suppressions ${whereSql}`, params)).rows[0]?.n ?? 0)
  const page = Math.max(1, Math.trunc(Number(f.page) || 1))
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const { rows } = await q.query<SuppressionRow>(
    `select ${ROW_COLS} from lp.suppressions ${whereSql} order by created_at desc, id desc limit ${PAGE_SIZE} offset ${(Math.min(page, pages) - 1) * PAGE_SIZE}`,
    params,
  )
  return { rows, total, page: Math.min(page, pages), pages }
}

export interface SuppressionMatch {
  id: number
  kind: 'email' | 'domain'
  reason: SuppressionReason
  campaign_id: number | null
}

export interface EmailCheck {
  suppressed: boolean
  by: SuppressionMatch | null
}

/**
 * Is each of these emails suppressed right now, for this campaign (or
 * globally)? ONE query for the whole batch -- never N calls. A campaign-scoped
 * live row wins over a global one; an email match wins over a domain match.
 */
export async function checkEmails(q: Queryable, emails: string[], campaignId?: number | null): Promise<Record<string, EmailCheck>> {
  const out: Record<string, EmailCheck> = {}
  const uniqueNorms = [...new Set(emails.filter(Boolean).map(normalizeEmail))]
  if (!uniqueNorms.length) {
    for (const e of emails) out[e] = { suppressed: false, by: null }
    return out
  }
  const { rows } = await q.query<{ email_norm: string; id: number | null; kind: 'email' | 'domain' | null; reason: SuppressionReason | null; campaign_id: number | null }>(
    `with input as (
       select e as email_norm, split_part(e, '@', 2) as domain from unnest($1::text[]) as e
     )
     select i.email_norm, m.id, m.kind, m.reason, m.campaign_id
       from input i
       left join lateral (
         select s.id, s.reason, s.campaign_id, case when s.email_norm = i.email_norm then 'email' else 'domain' end as kind
           from lp.suppressions s
          where s.lifted_at is null
            and (s.expires_at is null or s.expires_at > now())
            and (s.campaign_id is null or s.campaign_id = $2)
            and (s.email_norm = i.email_norm or s.domain = i.domain)
          order by (s.campaign_id is not null) desc, (s.email_norm is not null) desc, s.id
          limit 1
       ) m on true`,
    [uniqueNorms, campaignId == null ? null : Number(campaignId)],
  )
  const byNorm = new Map(rows.map((r) => [r.email_norm, r]))
  for (const e of emails) {
    const norm = normalizeEmail(e)
    const m = byNorm.get(norm)
    out[e] = m && m.id != null ? { suppressed: true, by: { id: m.id, kind: m.kind!, reason: m.reason!, campaign_id: m.campaign_id } } : { suppressed: false, by: null }
  }
  return out
}

// ---------------------------------------------------------------- CSV import / export

export interface ImportCsvResult {
  rows: number
  added: number
  already: number
  errors: { row: number; error: string }[]
}

/**
 * CSV columns: email or domain (one per row), reason (optional, default from
 * opts.reason), campaign_id (optional, overrides opts.campaign_id), note (optional).
 * Reuses lib/leads/csv.ts's parser (RFC 4180 + header-keyed objects).
 */
export async function importCsv(
  db: Db,
  actor: string,
  text: string,
  opts: { reason?: string; source?: string; campaign_id?: number | null } = {},
): Promise<ImportCsvResult> {
  const rows = csvObjects(text)
  const result: ImportCsvResult = { rows: rows.length, added: 0, already: 0, errors: [] }
  await db.tx(async (q) => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      try {
        const email = r.email || null
        const domain = r.domain || null
        if (!email && !domain) throw new SuppressionError('no email or domain column')
        const reason = r.reason || opts.reason || 'manual'
        const campaignIdRaw = r.campaign_id || (opts.campaign_id != null ? String(opts.campaign_id) : '')
        const { created } = await addSuppressionIn(q, actor, {
          email,
          domain,
          reason,
          source: opts.source ?? 'import',
          note: r.note || null,
          campaign_id: campaignIdRaw ? Number(campaignIdRaw) : null,
        })
        if (created) result.added++
        else result.already++
      } catch (e) {
        result.errors.push({ row: i + 2, error: (e as Error).message })
      }
    }
  }, actor)
  return result
}

function csvField(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function exportCsv(q: Queryable, f: ListSuppressionsFilter = {}): Promise<string> {
  // Export ignores pagination: every matching row, not just one page.
  const all: SuppressionRow[] = []
  let page = 1
  for (;;) {
    const { rows, pages } = await listSuppressions(q, { ...f, page })
    all.push(...rows)
    if (page >= pages) break
    page++
  }
  const header = ['id', 'email', 'domain', 'campaign_id', 'reason', 'source', 'note', 'created_at', 'expires_at', 'lifted_at']
  const lines = [header.join(',')]
  for (const r of all) {
    lines.push(
      [r.id, r.email_norm ?? '', r.domain ?? '', r.campaign_id ?? '', r.reason, r.source, r.note ?? '', r.created_at, r.expires_at ?? '', r.lifted_at ?? '']
        .map(csvField)
        .join(','),
    )
  }
  return lines.join('\r\n') + '\r\n'
}
