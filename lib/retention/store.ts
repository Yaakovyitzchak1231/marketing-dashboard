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

export async function listRetentionPolicies(q: Queryable): Promise<RetentionPolicyRow[]> {
  const { rows } = await q.query<RetentionPolicyRow>(`select * from lp.retention_policies order by event_category`)
  return rows
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

    // The person = this row plus every row ever merged into it (directly or through a chain):
    // a merged-away row still holds its own plaintext email/name/phone.
    const { rows: personRows } = await q.query<{ id: number; email: string | null }>(
      `with recursive person as (
         select id, email from lp.contacts where id = $1
         union
         select c.id, c.email from lp.contacts c join person p on c.merged_into = p.id
       ) select id, email from person`,
      [contactId],
    )
    const ids = personRows.map((r) => Number(r.id))
    const emails = [...new Set(personRows.map((r) => normalizeEmail(r.email)).filter((e): e is string => Boolean(e)))]

    await q.query(
      `update lp.contacts set email = null, email_norm = null, first_name = null, last_name = null, suggested_first_name = null,
              title = null, phone = null, phone_e164 = null, personalization = null, name_evidence_url = null,
              custom = '{}'::jsonb, do_not_contact = true, status = 'do-not-contact', updated_at = now()
         where id = any($1::bigint[])`,
      [ids],
    )
    await q.query(`delete from lp.enrichment where contact_id = any($1::bigint[])`, [ids])
    await q.query(`delete from lp.sources where contact_id = any($1::bigint[])`, [ids])
    await q.query(`update lp.campaign_touches set email = null, payload = coalesce(payload, '{}'::jsonb) - 'email' - 'personalization' where contact_id = any($1::bigint[])`, [ids])
    await q.query(`update lp.verification_results set email = '[forgotten]' where contact_id = any($1::bigint[])`, [ids])
    // The timeline keeps the event (counts stay true) but not the address.
    await q.query(
      `update lp.lead_events set email_norm = null, props = props - 'email' - 'lead_email'
        where contact_id = any($1::bigint[]) or email_norm = any($2::text[])`,
      [ids, emails],
    )
    await q.query(`update lp.consent_log set evidence = null where contact_id = any($1::bigint[])`, [ids])
    // The contact's own edit history can hold the same PII (an old email in an InlineEditCell change); clear it.
    await q.query(`delete from lp.status_history where entity_type = 'contact' and entity_id = any($1::bigint[]) and field = any($2::text[])`, [ids, PII_HISTORY_FIELDS])

    // Plaintext suppressions for any of the person's addresses become hashed ones (same
    // reason / campaign scope), so the block survives without keeping the address.
    for (const e of emails) {
      await q.query(
        `insert into lp.suppressions (email_hash, campaign_id, reason, source, note, created_by, expires_at)
         select $1, s.campaign_id, s.reason, s.source, 'Hashed when the person was forgotten', $3, s.expires_at
           from lp.suppressions s where s.email_norm = $2 and s.lifted_at is null
         on conflict do nothing`,
        [emailHash(e), e, actor],
      )
    }
    if (emails.length) await q.query(`delete from lp.suppressions where email_norm = any($1::text[])`, [emails])

    let suppressed = false
    for (const e of emails) {
      await q.query(
        `insert into lp.suppressions (email_hash, reason, source, note, created_by)
           values ($1, 'do_not_contact', 'manual', 'Forgotten via Settings/lead page (data retention request)', $2)
         on conflict do nothing`,
        [emailHash(e), actor],
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
export interface RetentionPreviewRow {
  event_category: string
  keep_days: number
  /** Raw campaign-touch rows past the window: what a sweep deletes. */
  touches: number
  /** Timeline (lp.lead_events) rows of the same type past the window: deleted only when the owner opts in. */
  timeline_events: number
}

export interface RetentionPreview {
  categories: RetentionPreviewRow[]
  total_touches: number
  total_timeline_events: number
}

/** What a sweep would delete right now, per category. Deletes nothing. */
export async function retentionPreview(q: Queryable): Promise<RetentionPreview> {
  const { rows } = await q.query<{ event_category: string; keep_days: number; touches: number; timeline_events: number }>(
    `select p.event_category, p.keep_days,
            (select count(*)::int from lp.campaign_touches t
              where t.event_type = p.event_category and t.occurred_at < now() - (p.keep_days || ' days')::interval) as touches,
            (select count(*)::int from lp.lead_events e
              where e.type = p.event_category and e.occurred_at < now() - (p.keep_days || ' days')::interval) as timeline_events
       from lp.retention_policies p
      where p.keep_days is not null
      order by p.event_category`,
  )
  const categories = rows.map((r) => ({ event_category: r.event_category, keep_days: Number(r.keep_days), touches: Number(r.touches), timeline_events: Number(r.timeline_events) }))
  return {
    categories,
    total_touches: categories.reduce((n, c) => n + c.touches, 0),
    total_timeline_events: categories.reduce((n, c) => n + c.timeline_events, 0),
  }
}

export interface RetentionSweepResult {
  swept: { event_category: string; keep_days: number; deleted: number; timeline_deleted: number }[]
  total_deleted: number
  total_timeline_deleted: number
}

export interface RetentionSweepOptions {
  /** The owner reviewed the preview and said yes. Without it nothing is deleted. */
  confirm?: boolean
  /** Also delete timeline history (lp.lead_events) past each window. Off unless the owner ticks it. */
  include_timeline?: boolean
}

/**
 * Deletes raw campaign-touch events past each category's keep_days -- only when the
 * owner confirmed this run (Yaakov, Oct 11: the owner chooses every time it runs).
 * Timeline history is deleted only with include_timeline. Scores keep working: a
 * score point whose source event is deleted keeps its points (score_points.source_event_id
 * is set null by its FK), so totals do not change.
 */
export async function retentionSweep(db: Db, actor: string, opts: RetentionSweepOptions = {}): Promise<RetentionSweepResult> {
  if (opts.confirm !== true) {
    throw new RetentionError('Review what this sweep will delete first, then confirm it. Nothing was deleted.', 409)
  }
  const includeTimeline = opts.include_timeline === true
  return db.tx(async (q) => {
    const { rows: policies } = await q.query<{ event_category: string; keep_days: number }>(
      `select event_category, keep_days from lp.retention_policies where keep_days is not null`,
    )
    if (includeTimeline) {
      // The maintenance escape hatch (0017/0018): the only way lead_events rows may be deleted.
      await q.query("select set_config('lp.maintenance', 'on', true)")
    }
    const swept: RetentionSweepResult['swept'] = []
    let total = 0
    let totalTimeline = 0
    for (const p of policies) {
      const { rows } = await q.query<{ n: number }>(
        `with gone as (
           delete from lp.campaign_touches where event_type = $1 and occurred_at < now() - ($2 || ' days')::interval returning id
         ) select count(*)::int as n from gone`,
        [p.event_category, p.keep_days],
      )
      const deleted = Number(rows[0]?.n ?? 0)
      let timelineDeleted = 0
      if (includeTimeline) {
        const t = await q.query<{ n: number }>(
          `with gone as (
             delete from lp.lead_events where type = $1 and occurred_at < now() - ($2 || ' days')::interval returning id
           ) select count(*)::int as n from gone`,
          [p.event_category, p.keep_days],
        )
        timelineDeleted = Number(t.rows[0]?.n ?? 0)
      }
      swept.push({ event_category: p.event_category, keep_days: p.keep_days, deleted, timeline_deleted: timelineDeleted })
      total += deleted
      totalTimeline += timelineDeleted
    }
    if (includeTimeline) await q.query("select set_config('lp.maintenance', 'off', true)")
    await q.query(
      `insert into lp.status_history (entity_type, entity_key, field, new_value, changed_by, via, note)
         values ('job', 'retention_sweep', 'run', $1, $2, 'ops_api', $3)`,
      [String(total + totalTimeline), actor,
       `Retention sweep (confirmed by ${actor}) deleted ${total} event row(s)${includeTimeline ? ` and ${totalTimeline} timeline row(s)` : ', timeline kept'} across ${swept.length} categor${swept.length === 1 ? 'y' : 'ies'}`],
    )
    return { swept, total_deleted: total, total_timeline_deleted: totalTimeline }
  }, actor)
}
