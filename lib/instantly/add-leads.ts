/**
 * "Add selected to Instantly campaign": preview first, then one confirmed send.
 *
 * Preview (no write anywhere outside our DB): for the chosen leads, pick each
 * company's best contact and sort them into
 *   ready        verified valid, not do-not-contact, not in Instantly yet
 *   excluded     with the reason (not verified, invalid, do-not-contact,
 *                already in Instantly per a read-only lookup, already touched
 *                by a campaign in our records, no email)
 * The preview is stored as an lp.instantly_actions row (status 'preview').
 *
 * Confirm (the human's second click): send only the stored ready list, in
 * chunks of 1000, with skip_if_in_workspace on. A row that is not 'preview'
 * is never sent again (double clicks, refreshes and retries are no-ops).
 * Afterwards each sent contact gets a campaign touch ('added_to_campaign'),
 * status 'in-Instantly', and the activity log says what happened.
 */
import type { Db, Queryable } from '@/lib/db/types'
import { logEvent } from '@/lib/ops/events'
import type { AddLead, AddLeadsResult, InstantlyWriter } from '@/lib/instantly/writer'
import { InstantlyWriteError } from '@/lib/instantly/writer'

export type ExcludeReason =
  | 'no_email'
  | 'not_verified'
  | 'invalid'
  | 'do_not_contact'
  | 'in_instantly'
  | 'already_in_campaign'

export const EXCLUDE_WORDS: Record<ExcludeReason, string> = {
  no_email: 'No email address',
  not_verified: 'Email not verified yet',
  invalid: 'Email failed verification',
  do_not_contact: 'Marked do-not-contact',
  in_instantly: 'Already in Instantly',
  already_in_campaign: 'Already in a campaign (our records)',
}

export interface PreviewLead {
  contact_id: number
  company_id: number
  email: string | null
  first_name: string | null
  last_name: string | null
  company: string
  website: string | null
  phone: string | null
  personalization: string | null
  verification_status: string
  excluded: ExcludeReason | null
}

export interface AddPreview {
  campaign_id: string
  campaign_name: string | null
  ready: PreviewLead[]
  excluded: PreviewLead[]
  /** null when the Instantly lookup could not run (then nothing is marked "already in Instantly"). */
  instantlyChecked: boolean
  instantlyNote: string | null
}

const BEST_CONTACT = `
  select distinct on (ct.company_id)
         ct.id as contact_id, ct.company_id, ct.email, ct.email_norm, ct.first_name, ct.last_name,
         ct.verification_status, ct.do_not_contact, ct.personalization, ct.status,
         co.name as company, co.website, co.phone,
         exists (select 1 from lp.campaign_touches t where t.contact_id = ct.id and t.campaign_id is not null) as touched
    from lp.contacts ct
    join lp.companies co on co.id = ct.company_id
   where ct.company_id = any($1::bigint[])
   order by ct.company_id,
            (ct.verification_status = 'valid') desc,
            (ct.is_role_address is not true) desc,
            ct.id`

type Row = {
  contact_id: number
  company_id: number
  email: string | null
  email_norm: string | null
  first_name: string | null
  last_name: string | null
  verification_status: string
  do_not_contact: boolean
  personalization: string | null
  status: string
  company: string
  website: string | null
  phone: string | null
  touched: boolean
}

export function reasonFor(r: Row, inInstantly: Set<string>): ExcludeReason | null {
  if (!r.email_norm) return 'no_email'
  if (r.do_not_contact || r.status === 'do-not-contact') return 'do_not_contact'
  if (r.verification_status === 'invalid') return 'invalid'
  if (r.verification_status !== 'valid') return 'not_verified'
  if (inInstantly.has(r.email_norm)) return 'in_instantly'
  if (r.touched || ['in-Instantly', 'sent', 'replied', 'bounced'].includes(r.status)) return 'already_in_campaign'
  return null
}

export async function buildAddPreview(
  q: Queryable,
  input: { campaign_id: string; campaign_name?: string | null; company_ids: number[] },
  lookupInInstantly: ((emails: string[]) => Promise<string[]>) | null,
): Promise<AddPreview> {
  const ids = [...new Set(input.company_ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 5000)
  const { rows } = await q.query<Row>(BEST_CONTACT, [ids])
  const emails = rows.map((r) => r.email_norm).filter((e): e is string => Boolean(e))
  let inInstantly = new Set<string>()
  let checked = false
  let note: string | null = null
  if (lookupInInstantly && emails.length) {
    try {
      inInstantly = new Set((await lookupInInstantly(emails)).map((e) => e.trim().toLowerCase()))
      checked = true
    } catch (e) {
      note = `Couldn't check Instantly for duplicates (${(e as Error).message}). Instantly will still skip any lead already in the workspace when you confirm.`
    }
  } else if (!lookupInInstantly) {
    note = 'Instantly is not connected, so duplicates were not looked up.'
  } else checked = true
  const leads: PreviewLead[] = rows.map((r) => ({
    contact_id: r.contact_id,
    company_id: r.company_id,
    email: r.email,
    first_name: r.first_name,
    last_name: r.last_name,
    company: r.company,
    website: r.website,
    phone: r.phone,
    personalization: r.personalization,
    verification_status: r.verification_status,
    excluded: reasonFor(r, inInstantly),
  }))
  return {
    campaign_id: input.campaign_id,
    campaign_name: input.campaign_name ?? null,
    ready: leads.filter((l) => !l.excluded),
    excluded: leads.filter((l) => l.excluded),
    instantlyChecked: checked,
    instantlyNote: note,
  }
}

export interface ActionRow {
  id: number
  kind: 'add_leads' | 'pause' | 'resume'
  campaign_id: string
  campaign_name: string | null
  contact_ids: number[]
  status: 'preview' | 'sending' | 'done' | 'failed' | 'unknown' | 'cancelled'
  preview: AddPreview | null
  result: Record<string, unknown> | null
  error: string | null
  created_by: string | null
  confirmed_by: string | null
  created_at: string
  finished_at: string | null
}

export async function savePreview(q: Queryable, actor: string, p: AddPreview): Promise<ActionRow> {
  const { rows } = await q.query<ActionRow>(
    `insert into lp.instantly_actions (kind, campaign_id, campaign_name, contact_ids, preview, created_by)
     values ('add_leads', $1, $2, $3::bigint[], $4, $5) returning *`,
    [p.campaign_id, p.campaign_name, p.ready.map((l) => l.contact_id), JSON.stringify(p), actor],
  )
  return rows[0]
}

export async function getAction(q: Queryable, id: number): Promise<ActionRow | null> {
  const { rows } = await q.query<ActionRow>('select * from lp.instantly_actions where id = $1', [id])
  return rows[0] ?? null
}

export async function recentActions(q: Queryable, limit = 10): Promise<ActionRow[]> {
  const { rows } = await q.query<ActionRow>('select * from lp.instantly_actions where status <> $1 order by id desc limit $2', ['preview', limit])
  return rows
}

export function toAddLead(l: PreviewLead): AddLead {
  const out: AddLead = { email: (l.email ?? '').trim() }
  if (l.first_name) out.first_name = l.first_name
  if (l.last_name) out.last_name = l.last_name
  if (l.company) out.company_name = l.company
  if (l.website) out.website = l.website
  if (l.phone) out.phone = l.phone
  if (l.personalization) out.personalization = l.personalization
  return out
}

/** Atomically move a preview row to 'sending'. Returns null when it was not a preview any more. */
async function claim(db: Db, id: number, actor: string): Promise<ActionRow | null> {
  const { rows } = await db.query<ActionRow>(
    `update lp.instantly_actions set status = 'sending', confirmed_by = $2, confirmed_at = now()
      where id = $1 and status = 'preview' returning *`,
    [id, actor],
  )
  return rows[0] ?? null
}

export interface ConfirmOutcome {
  action: ActionRow
  sent: boolean
  message: string
}

export async function confirmAddLeads(db: Db, writer: InstantlyWriter, id: number, actor: string): Promise<ConfirmOutcome> {
  const row = await claim(db, id, actor)
  if (!row) {
    const existing = await getAction(db, id)
    if (!existing) throw new Error('That preview does not exist.')
    return { action: existing, sent: false, message: `Already ${existing.status}; nothing was sent again.` }
  }
  const ready = (row.preview?.ready ?? []).filter((l) => l.email)
  if (ready.length === 0) {
    const { rows } = await db.query<ActionRow>(
      `update lp.instantly_actions set status = 'cancelled', finished_at = now(), error = 'nothing to send' where id = $1 returning *`,
      [id],
    )
    return { action: rows[0], sent: false, message: 'Nothing was ready to add, so nothing was sent.' }
  }
  const results: AddLeadsResult[] = []
  let failure: InstantlyWriteError | null = null
  let sentCount = 0
  for (let i = 0; i < ready.length; i += 1000) {
    const chunk = ready.slice(i, i + 1000)
    try {
      results.push(await writer.addLeads(row.campaign_id, chunk.map(toAddLead)))
      sentCount += chunk.length
    } catch (e) {
      failure = e instanceof InstantlyWriteError ? e : new InstantlyWriteError(String((e as Error).message ?? e), null, true)
      break
    }
  }
  const uploaded = results.reduce((s, r) => s + (typeof r.leads_uploaded === 'number' ? r.leads_uploaded : 0), 0)
  const anyCount = results.some((r) => typeof r.leads_uploaded === 'number')
  const summary = {
    chunks: results,
    leads_offered: ready.length,
    leads_in_accepted_calls: sentCount,
    leads_uploaded: anyCount ? uploaded : null,
  }
  const status: ActionRow['status'] = failure ? (failure.unknownOutcome ? 'unknown' : sentCount > 0 ? 'unknown' : 'failed') : 'done'
  const sentIds = ready.slice(0, sentCount).map((l) => l.contact_id)
  const out = await db.tx(async (q) => {
    const { rows } = await q.query<ActionRow>(
      `update lp.instantly_actions set status = $2, result = $3, error = $4, finished_at = now() where id = $1 returning *`,
      [id, status, JSON.stringify(summary), failure ? failure.message : null],
    )
    if (sentIds.length) {
      await q.query(
        `insert into lp.campaign_touches (contact_id, company_id, email, campaign_id, campaign_name, event_type, source, external_id)
         select c.id, c.company_id, c.email, $2, $3, 'added_to_campaign', 'dashboard', 'instantly_action:' || $4 || ':' || c.id
           from lp.contacts c where c.id = any($1::bigint[])`,
        [sentIds, row.campaign_id, row.campaign_name, String(id)],
      )
      await q.query(`update lp.contacts set status = 'in-Instantly' where id = any($1::bigint[]) and status in ('new', 'valid-ready', 'verifying')`, [sentIds])
      await q.query(
        `update lp.companies set stage = 'in_campaign' where id in (select company_id from lp.contacts where id = any($1::bigint[])) and stage in ('new', 'researched', 'ready')`,
        [sentIds],
      )
    }
    const what = row.campaign_name ? `"${row.campaign_name}"` : 'an Instantly campaign'
    await logEvent(q, {
      actor,
      kind: failure ? 'instantly.add_leads_failed' : 'instantly.add_leads',
      summary: failure
        ? `Adding ${ready.length} leads to ${what} did not finish: ${failure.message}`
        : `Added leads to ${what}: ${ready.length} sent${anyCount ? `, Instantly took ${uploaded}` : ''}`,
      entity_type: 'campaign',
      entity_id: row.campaign_id,
      data: summary,
    })
    return rows[0]
  }, actor)
  const message = failure
    ? failure.message
    : anyCount
      ? `Sent ${ready.length} to Instantly; it added ${uploaded} (it skips any already in the workspace or on the blocklist).`
      : `Sent ${ready.length} to Instantly.`
  return { action: out, sent: sentCount > 0, message }
}

/** Pause or resume, recorded the same way. */
export async function campaignSwitch(
  db: Db,
  writer: InstantlyWriter,
  actor: string,
  input: { kind: 'pause' | 'resume'; campaign_id: string; campaign_name?: string | null },
): Promise<{ ok: boolean; message: string; action: ActionRow }> {
  const { rows } = await db.query<ActionRow>(
    `insert into lp.instantly_actions (kind, campaign_id, campaign_name, status, created_by, confirmed_by, confirmed_at)
     values ($1, $2, $3, 'sending', $4, $4, now()) returning *`,
    [input.kind, input.campaign_id, input.campaign_name ?? null, actor],
  )
  const row = rows[0]
  let err: InstantlyWriteError | null = null
  let result: Record<string, unknown> | null = null
  try {
    result = input.kind === 'pause' ? await writer.pause(input.campaign_id) : await writer.resume(input.campaign_id)
  } catch (e) {
    err = e instanceof InstantlyWriteError ? e : new InstantlyWriteError(String((e as Error).message ?? e), null, true)
  }
  const status = err ? (err.unknownOutcome ? 'unknown' : 'failed') : 'done'
  const name = input.campaign_name ? `"${input.campaign_name}"` : 'a campaign'
  const verb = input.kind === 'pause' ? 'Paused' : 'Resumed'
  const out = await db.tx(async (q) => {
    const r = await q.query<ActionRow>(
      `update lp.instantly_actions set status = $2, result = $3, error = $4, finished_at = now() where id = $1 returning *`,
      [row.id, status, result ? JSON.stringify({ status: (result as { status?: unknown }).status ?? null }) : null, err ? err.message : null],
    )
    await logEvent(q, {
      actor,
      kind: err ? `instantly.${input.kind}_failed` : `instantly.${input.kind}`,
      summary: err ? `${verb.replace(/d$/, '')} ${name} did not go through: ${err.message}` : `${verb} ${name} in Instantly`,
      entity_type: 'campaign',
      entity_id: input.campaign_id,
    })
    return r.rows[0]
  }, actor)
  return { ok: !err, message: err ? err.message : `${verb} ${name}. Instantly may take a minute to show it.`, action: out }
}
