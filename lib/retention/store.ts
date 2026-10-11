/**
 * Data retention & delete-a-person (plan 1.12). Schema: 0027_retention.sql.
 *
 * lp.retention_policies says how long raw campaign-touch events are kept by
 * event_category (= lp.campaign_touches.event_type); null keep_days = forever.
 * forget_contact removes PII from a contact in place and suppresses their
 * email by a sha256 HASH (never the plaintext -- that would defeat the point)
 * so a later import of the same address is blocked without the forgotten
 * address being stored anywhere new. retention_sweep deletes the events a
 * policy says have aged out.
 */
import { createHash } from 'node:crypto'
import type { Db, Queryable } from '../db/types'
import { normalizeEmail } from '../leads/normalize'

export class RetentionError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export function emailHash(email: string): string {
  return createHash('sha256').update(email).digest('hex')
}

/** Has this email been forgotten? Checked by hash, computed live from the plaintext the caller has in hand (the import row, a new signup...). */
export async function isForgottenEmail(q: Queryable, email: string | null | undefined): Promise<boolean> {
  const norm = normalizeEmail(email)
  if (!norm) return false
  const { rows } = await q.query<{ n: number }>(
    `select count(*)::int as n from lp.suppressions
      where email_hash = $1 and lifted_at is null and (expires_at is null or expires_at > now())`,
    [emailHash(norm)],
  )
  return Number(rows[0]?.n ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Retention policies
// ---------------------------------------------------------------------------
export interface RetentionPolicyRow {
  event_category: string
  keep_days: number | null
  description: string | null
  updated_by: string | null
  updated_at: string
}

/** Never throws: previews never migrate, so 0027's table can still be missing there. */
export async function listRetentionPolicies(q: Queryable): Promise<RetentionPolicyRow[]> {
  try {
    const { rows } = await q.query<RetentionPolicyRow>(`select * from lp.retention_policies order by event_category`)
    return rows
  } catch (e) {
    if (/does not exist/i.test((e as Error).message ?? '')) return []
    throw e
  }
}

export async function setRetentionPolicy(db: Db, actor: string, input: { event_category: string; keep_days: number | null }): Promise<RetentionPolicyRow> {
  const category = input.event_category.trim()
  if (!/^[a-z][a-z0-9_]{0,60}$/.test(category)) throw new RetentionError('event_category must be lowercase_snake_case')
  const keepDays = input.keep_days
  if (keepDays !== null && (!Number.isInteger(keepDays) || keepDays <= 0)) throw new RetentionError('keep_days must be a positive integer, or null for forever')
  return db.tx(async (q) => {
    const { rows } = await q.query<RetentionPolicyRow>(
      `insert into lp.retention_policies (event_category, keep_days, updated_by)
         values ($1, $2, $3)
       on conflict (event_category) do update set keep_days = excluded.keep_days, updated_by = excluded.updated_by, updated_at = now()
       returning *`,
      [category, keepDays, actor],
    )
    await q.query(
      `insert into lp.status_history (entity_type, entity_key, field, new_value, changed_by, via, note)
         values ('setting', $1, 'retention_keep_days', $2, $3, 'ui', $4)`,
      [`retention.${category}`, keepDays === null ? 'forever' : String(keepDays), actor, `Retention for "${category}" set to ${keepDays === null ? 'forever' : `${keepDays} days`}`],
    )
    return rows[0]
  }, actor)
}

// ---------------------------------------------------------------------------
// forget_contact
// ---------------------------------------------------------------------------
export interface ForgetContactInput {
  contact_id: number
  /** Typed confirmation: the contact's current (normalized) email, or "forget" when the contact has none. */
  confirm: string
}

export interface ForgetContactResult {
  ok: true
  contact_id: number
  suppressed: boolean
}

const PII_HISTORY_FIELDS = ['email', 'first_name', 'last_name', 'title', 'phone', 'personalization', 'suggested_first_name', 'name_evidence_url']

export async function forgetContact(db: Db, actor: string, input: ForgetContactInput): Promise<ForgetContactResult> {
  const contactId = Number(input.contact_id)
  if (!Number.isInteger(contactId) || contactId <= 0) throw new RetentionError('contact_id must be a positive integer')
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: number; email: string | null; merged_into: number | null }>(
      `select id, email, merged_into from lp.contacts where id = $1`,
      [contactId],
    )
    const contact = rows[0]
    if (!contact) throw new RetentionError(`Contact ${contactId} not found`, 404)
    if (contact.merged_into != null) throw new RetentionError(`Contact ${contactId} was merged into ${contact.merged_into}; forget that row instead`, 409)

    const norm = normalizeEmail(contact.email)
    const expected = norm ?? 'forget'
    if ((input.confirm ?? '').trim().toLowerCase() !== expected) {
      throw new RetentionError(norm ? `Type the contact's email ("${norm}") to confirm` : 'Type "forget" to confirm')
    }

    // The maintenance escape hatch (0017): the only way status_history rows may be deleted.
    await q.query("select set_config('lp.maintenance', 'on', true)")

    await q.query(
      `update lp.contacts set email = null, email_norm = null, first_name = null, last_name = null, suggested_first_name = null,
              title = null, phone = null, phone_e164 = null, personalization = null, name_evidence_url = null,
              do_not_contact = true, status = 'do-not-contact', updated_at = now()
         where id = $1`,
      [contactId],
    )
    await q.query(`delete from lp.enrichment where contact_id = $1`, [contactId])
    await q.query(`delete from lp.sources where contact_id = $1`, [contactId])
    await q.query(`update lp.campaign_touches set email = null, payload = coalesce(payload, '{}'::jsonb) - 'email' - 'personalization' where contact_id = $1`, [contactId])
    await q.query(`update lp.verification_results set email = '[forgotten]' where contact_id = $1`, [contactId])
    // The contact's own edit history can hold the same PII (an old email in an InlineEditCell change); clear it.
    await q.query(`delete from lp.status_history where entity_type = 'contact' and entity_id = $1 and field = any($2::text[])`, [contactId, PII_HISTORY_FIELDS])

    let suppressed = false
    if (norm) {
      await q.query(
        `insert into lp.suppressions (email_hash, reason, source, note, created_by)
           values ($1, 'do_not_contact', 'manual', 'Forgotten via Settings/lead page (data retention request)', $2)
         on conflict do nothing`,
        [emailHash(norm), actor],
      )
      suppressed = true
    }

    await q.query(
      `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via, note)
         values ('contact', $1, 'forgotten', null, 'true', $2, 'ui', 'PII removed per data retention request ("Forget this person")')`,
      [contactId, actor],
    )
    return { ok: true as const, contact_id: contactId, suppressed }
  }, actor)
}

// ---------------------------------------------------------------------------
// retention_sweep
// ---------------------------------------------------------------------------
export interface RetentionSweepResult {
  swept: { event_category: string; keep_days: number; deleted: number }[]
  total_deleted: number
}

export async function retentionSweep(db: Db, actor: string): Promise<RetentionSweepResult> {
  return db.tx(async (q) => {
    const { rows: policies } = await q.query<{ event_category: string; keep_days: number }>(
      `select event_category, keep_days from lp.retention_policies where keep_days is not null`,
    )
    const swept: RetentionSweepResult['swept'] = []
    let total = 0
    for (const p of policies) {
      const { rows } = await q.query<{ n: number }>(
        `with gone as (
           delete from lp.campaign_touches where event_type = $1 and occurred_at < now() - ($2 || ' days')::interval returning id
         ) select count(*)::int as n from gone`,
        [p.event_category, p.keep_days],
      )
      const deleted = Number(rows[0]?.n ?? 0)
      swept.push({ event_category: p.event_category, keep_days: p.keep_days, deleted })
      total += deleted
    }
    await q.query(
      `insert into lp.status_history (entity_type, entity_key, field, new_value, changed_by, via, note)
         values ('job', 'retention_sweep', 'run', $1, $2, 'ops_api', $3)`,
      [String(total), actor, `Retention sweep deleted ${total} event row(s) across ${swept.length} categor${swept.length === 1 ? 'y' : 'ies'}`],
    )
    return { swept, total_deleted: total }
  }, actor)
}
