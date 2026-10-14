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
import { getJob, runNow } from '../jobs/store'

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
    const emailsSet = new Set<string>()
    for (const r of personRows) {
      const e = normalizeEmail(r.email)
      if (e) emailsSet.add(e)
    }
    const emails = Array.from(emailsSet)

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

/**
 * What deleting timeline history would change (Instinct #86 finding 4). Scores, traits,
 * segment event conditions, lead milestones and engagement benchmarks are all computed
 * from lp.lead_events, so the owner sees which of them read the event types this sweep
 * would delete BEFORE choosing to include timeline history.
 */
export interface TimelineImpact {
  /** Event types that have timeline rows past their window (what the opt-in would delete). */
  event_types: string[]
  /** Active score models with a rule on one of those event types. */
  score_models: { id: number; name: string }[]
  /** Live traits computed from one of those event types. */
  traits: { key: string; label: string }[]
  /** Live segments with an event condition on one of those event types. */
  segments: { id: number; name: string }[]
  /** One plain sentence for the confirm step. */
  note: string
}

export interface RetentionPreview {
  categories: RetentionPreviewRow[]
  total_touches: number
  total_timeline_events: number
  /** Present when any timeline rows are past their window. */
  timeline_impact?: TimelineImpact
}

/** A table this deploy hasn't migrated yet (SQLSTATE 42P01 only): list nothing for it. */
async function listOrEmpty<T>(run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run()
  } catch (e) {
    if ((e as { code?: string }).code === '42P01') return []
    throw e
  }
}

export async function timelineImpact(q: Queryable, eventTypes: string[]): Promise<TimelineImpact> {
  const types = [...new Set(eventTypes)].sort()
  const score_models = await listOrEmpty(async () => (await q.query<{ id: number; name: string }>(
    `select id, name from lp.score_models
      where active and exists (select 1 from jsonb_array_elements(rules) r where r->>'event_type' = any($1::text[]))
      order by name, id`,
    [types],
  )).rows.map((r) => ({ id: Number(r.id), name: r.name })))
  const traits = await listOrEmpty(async () => (await q.query<{ key: string; label: string }>(
    `select key, label from lp.traits
      where archived_at is null
        and jsonb_typeof(definition->'event_types') = 'array'
        and exists (select 1 from jsonb_array_elements_text(definition->'event_types') t where t = any($1::text[]))
      order by label, key`,
    [types],
  )).rows)
  const segments = await listOrEmpty(async () => (await q.query<{ id: number; name: string }>(
    `select id, name from lp.segments
      where archived_at is null
        and exists (select 1 from jsonb_path_query(definition, 'lax $.**.event_type') v where v #>> '{}' = any($1::text[]))
      order by name, id`,
    [types],
  )).rows.map((r) => ({ id: Number(r.id), name: r.name })))
  const note =
    'Deleting timeline history changes everything computed from those events: traits, segment event conditions, ' +
    'lead milestones and engagement benchmarks are recalculated without them. Score points already earned are kept. ' +
    'A score and trait recompute is queued after the sweep.'
  return { event_types: types, score_models, traits, segments, note }
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
  const preview: RetentionPreview = {
    categories,
    total_touches: categories.reduce((n, c) => n + c.touches, 0),
    total_timeline_events: categories.reduce((n, c) => n + c.timeline_events, 0),
  }
  const timelineTypes = categories.filter((c) => c.timeline_events > 0).map((c) => c.event_category)
  if (timelineTypes.length) preview.timeline_impact = await timelineImpact(q, timelineTypes)
  return preview
}

export interface RetentionSweepResult {
  swept: { event_category: string; keep_days: number; deleted: number; timeline_deleted: number }[]
  total_deleted: number
  total_timeline_deleted: number
  /** Runner jobs queued (run now) because timeline history was deleted: 'score_refresh', 'traits_refresh'. */
  recompute_queued: string[]
}

export interface RetentionSweepOptions {
  /** The owner reviewed the preview and said yes. Without it nothing is deleted. */
  confirm?: boolean
  /** Also delete timeline history (lp.lead_events) past each window. Off unless the owner ticks it. */
  include_timeline?: boolean
  /** Rows deleted per statement (each batch is its own short transaction). Default 5000. */
  batch_size?: number
}

export const RETENTION_BATCH_SIZE = 5000

/**
 * One batch of at most `limit` rows of `table` of this category older than the cutoff, in
 * its own short transaction. For lp.lead_events the append-only escape hatch (lp.maintenance,
 * migrations 0018/0036) is switched on with set_config(..., true) -- transaction-local -- inside
 * THIS transaction only, and switched off again before it commits (Instinct #86 finding 10).
 */
async function deleteBatch(db: Db, actor: string, table: 'campaign_touches' | 'lead_events', category: string, cutoff: string, limit: number): Promise<number> {
  const typeCol = table === 'lead_events' ? 'type' : 'event_type'
  return db.tx(async (q) => {
    if (table === 'lead_events') await q.query("select set_config('lp.maintenance', 'on', true)")
    const { rows } = await q.query<{ n: number }>(
      `with victims as (
         select id from lp.${table} where ${typeCol} = $1 and occurred_at < $2::timestamptz order by id limit $3
       ), gone as (
         delete from lp.${table} t using victims v where t.id = v.id returning t.id
       ) select count(*)::int as n from gone`,
      [category, cutoff, limit],
    )
    if (table === 'lead_events') await q.query("select set_config('lp.maintenance', 'off', true)")
    return Number(rows[0]?.n ?? 0)
  }, actor)
}

async function deleteAllBatches(db: Db, actor: string, table: 'campaign_touches' | 'lead_events', category: string, cutoff: string, limit: number, onBatch: (n: number) => void): Promise<void> {
  for (;;) {
    const n = await deleteBatch(db, actor, table, category, cutoff, limit)
    onBatch(n)
    if (n < limit) return
  }
}

/**
 * Deletes raw campaign-touch events past each category's keep_days -- only when the
 * owner confirmed this run (Yaakov, Oct 11: the owner chooses every time it runs).
 * Timeline history is deleted only with include_timeline; it is never on by default.
 *
 * Batched (Instinct #86 finding 4): rows go in chunks of `batch_size`, each chunk its own
 * short transaction, against one cutoff fixed when the sweep starts -- no single unbounded
 * delete holding locks. A re-run finishes whatever an interrupted sweep left.
 *
 * Score points already earned are kept (score_points.source_event_id is set null by its
 * FK, and recompute only rebuilds points that still have a source event). Traits, segment
 * event conditions, milestones and benchmarks are computed from the events, so when any
 * timeline rows were deleted the sweep resets the affected traits to a full recompute and
 * queues the 'score_refresh' and 'traits_refresh' runner jobs (never recomputes inline).
 */
export async function retentionSweep(db: Db, actor: string, opts: RetentionSweepOptions = {}): Promise<RetentionSweepResult> {
  if (opts.confirm !== true) {
    throw new RetentionError('Review what this sweep will delete first, then confirm it. Nothing was deleted.', 409)
  }
  const includeTimeline = opts.include_timeline === true
  const batch = Math.trunc(Number(opts.batch_size ?? RETENTION_BATCH_SIZE))
  if (!Number.isInteger(batch) || batch < 1 || batch > 50_000) throw new RetentionError('batch_size must be between 1 and 50000')

  const { rows: policies } = await db.query<{ event_category: string; keep_days: number; cutoff: string }>(
    `select event_category, keep_days, (now() - (keep_days || ' days')::interval)::text as cutoff
       from lp.retention_policies where keep_days is not null order by event_category`,
  )
  const swept: RetentionSweepResult['swept'] = []
  let total = 0
  let totalTimeline = 0
  let failure: unknown = null
  try {
    for (const p of policies) {
      const row = { event_category: p.event_category, keep_days: Number(p.keep_days), deleted: 0, timeline_deleted: 0 }
      swept.push(row)
      await deleteAllBatches(db, actor, 'campaign_touches', p.event_category, p.cutoff, batch, (n) => { row.deleted += n; total += n })
      if (includeTimeline) {
        await deleteAllBatches(db, actor, 'lead_events', p.event_category, p.cutoff, batch, (n) => { row.timeline_deleted += n; totalTimeline += n })
      }
    }
  } catch (e) {
    failure = e
  }

  // Audit + recompute in one closing transaction -- also after a failure partway, so what
  // already committed is recorded and the derived data catches up.
  const affectedTypes = swept.filter((r) => r.timeline_deleted > 0).map((r) => r.event_category)
  const recompute_queued: string[] = []
  if (failure && total + totalTimeline === 0) throw failure
  await db.tx(async (q) => {
    if (affectedTypes.length) {
      // traits_refresh is incremental (only entities with NEW events are recomputed), and a
      // delete adds no event, so reset the affected traits to "never computed" = full recompute.
      await q.query(
        `update lp.traits set last_computed_at = null
          where archived_at is null and jsonb_typeof(definition->'event_types') = 'array'
            and exists (select 1 from jsonb_array_elements_text(definition->'event_types') t where t = any($1::text[]))`,
        [affectedTypes],
      )
      for (const job of ['score_refresh', 'traits_refresh']) {
        if (await getJob(q, job)) {
          await runNow(q, actor, job)
          recompute_queued.push(job)
        }
      }
    }
    const summary =
      `Retention sweep (confirmed by ${actor}) deleted ${total} event row(s)` +
      (includeTimeline ? ` and ${totalTimeline} timeline row(s)` : ', timeline kept') +
      ` across ${swept.length} categor${swept.length === 1 ? 'y' : 'ies'}` +
      (recompute_queued.length ? `; queued ${recompute_queued.join(', ')}` : '') +
      (failure ? '; STOPPED PARTWAY on an error, run it again to finish' : '')
    await q.query(
      `insert into lp.status_history (entity_type, entity_key, field, new_value, changed_by, via, note)
         values ('job', 'retention_sweep', 'run', $1, $2, 'ops_api', $3)`,
      [String(total + totalTimeline), actor, summary],
    )
  }, actor)
  if (failure) {
    console.error('retention sweep stopped partway', (failure as Error).message)
    throw new RetentionError(
      `The sweep stopped partway after deleting ${total} event row(s)${includeTimeline ? ` and ${totalTimeline} timeline row(s)` : ''}. Run it again to finish.`,
      500,
    )
  }
  return { swept, total_deleted: total, total_timeline_deleted: totalTimeline, recompute_queued }
}
