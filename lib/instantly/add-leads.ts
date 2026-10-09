/**
 * "Add selected to Instantly campaign": preview first, then one confirmed send.
 *
 * Preview (no write anywhere outside our DB): for the chosen leads, pick each
 * company's best contact and sort them into
 *   ready        verified valid, not do-not-contact, not in Instantly yet
 *   excluded     with the reason (not verified, invalid, do-not-contact, on hold,
 *                already in Instantly per a read-only lookup, already touched
 *                by a campaign in our records, no email)
 * The preview is stored as an lp.instantly_actions row (status 'preview').
 *
 * Confirm (the human's second click): send only the stored ready list, in
 * chunks of 1000, with skip_if_in_workspace on. A row that is not 'preview'
 * is never sent again (double clicks, refreshes and retries are no-ops).
 * Afterwards each sent contact gets a campaign touch ('added_to_campaign'),
 * status 'in-Instantly', and the activity log says what happened.
 *
 * Only a human can send: every function here that calls Instantly checks the
 * actor is an active human first, and the database refuses a row moving to
 * 'sending' without a human confirmed_by (migration 0009). Agents queue
 * changes through lib/instantly/gate.ts, which a human approves.
 */
import type { Db, Queryable } from '@/lib/db/types'
import { HELD_STATUSES } from '@/lib/leads/types'
import { logEvent } from '@/lib/ops/events'
import type { AddLead, AddLeadsResult, InstantlyWriter } from '@/lib/instantly/writer'
import { InstantlyWriteError } from '@/lib/instantly/writer'
import { evaluateCompanies } from '@/lib/rules/recompute'
import { ruleSetForCampaign } from '@/lib/rules/store'
import { firstStanding, isReady, type Batch, type LeadVerdict, type ParkReason, type Tier } from '@/lib/rules/evaluate'

export type ExcludeReason =
  | 'no_email'
  | 'not_verified'
  | 'invalid'
  | 'do_not_contact'
  | 'on_hold'
  | 'in_instantly'
  | 'already_in_campaign'
  | 'rejected'
  | 'parked'
  | 'role_inbox_batch'
  | 'not_role_inbox'

export const EXCLUDE_WORDS: Record<ExcludeReason, string> = {
  no_email: 'No email address',
  not_verified: 'Email not verified yet',
  invalid: 'Email failed verification',
  do_not_contact: 'Marked do-not-contact',
  on_hold: 'On hold (role inbox until an owner email is found, or needs a check)',
  in_instantly: 'Already in Instantly',
  already_in_campaign: 'Already in a campaign (our records)',
  rejected: 'Rejected',
  parked: "Doesn't meet this campaign's rules",
  role_inbox_batch: 'Role inbox: goes only in its own role-inbox batch',
  not_role_inbox: 'Not a role inbox (this is a role-inbox batch)',
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
  /** The evaluator's verdict under this campaign's rules (lib/rules). */
  tier?: Tier | null
  /** Every rule that failed, in plain words (empty when Ready). */
  park_reasons?: string[]
  /** Personalization values sent as Instantly custom variables. */
  merge?: Record<string, string>
}

export interface AddPreview {
  campaign_id: string
  campaign_name: string | null
  ready: PreviewLead[]
  excluded: PreviewLead[]
  /** null when the Instantly lookup could not run (then nothing is marked "already in Instantly"). */
  instantlyChecked: boolean
  instantlyNote: string | null
  /** The rule set this preview was scored against. */
  rules?: { id: number; name: string; version: number } | null
  /** standard = named inboxes; role-inbox = released role inboxes only, sent apart and tagged. */
  batch?: Batch
}

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

/**
 * The standing exclusions on one contact row (kept for callers and tests that
 * check a single row; the preview itself uses the evaluator in lib/rules).
 */
export function reasonFor(r: Row, inInstantly: Set<string>): ExcludeReason | null {
  if (!r.email_norm) return 'no_email'
  if (r.do_not_contact || r.status === 'do-not-contact') return 'do_not_contact'
  if (HELD_STATUSES.includes(r.status)) return 'on_hold'
  if (r.verification_status === 'invalid') return 'invalid'
  if (r.verification_status !== 'valid') return 'not_verified'
  if (inInstantly.has(r.email_norm)) return 'in_instantly'
  if (r.touched || ['in-Instantly', 'sent', 'replied', 'bounced'].includes(r.status)) return 'already_in_campaign'
  return null
}

/** The preview's one-word reason for a parked lead (standing rules map 1:1; the email-status rule reads as not verified). */
export function excludeFor(v: { reasons: ParkReason[] }, emailRuleIds: Set<string>): ExcludeReason {
  const s = firstStanding(v)
  if (s) return s
  if (v.reasons.some((r) => emailRuleIds.has(r.rule))) return 'not_verified'
  return 'parked'
}

const CHOSEN = `
  select ct.id as contact_id, ct.company_id, ct.email, ct.email_norm, ct.first_name, ct.last_name,
         ct.verification_status, ct.personalization, co.name as company, co.website, co.phone
    from lp.contacts ct join lp.companies co on co.id = ct.company_id
   where ct.id = any($1::bigint[])`

type Chosen = Pick<Row, 'contact_id' | 'company_id' | 'email' | 'email_norm' | 'first_name' | 'last_name' | 'verification_status' | 'personalization' | 'company' | 'website' | 'phone'>

/**
 * Preview: each company is scored by THE evaluator (lib/rules) under the rules
 * this campaign uses right now (its own, else its pool's, else the default).
 * Ready-personalized and Ready-generic leads are ready; parked leads say why.
 * Companies with no contact at all are left out of the preview.
 */
export async function buildAddPreview(
  q: Queryable,
  input: { campaign_id: string; campaign_name?: string | null; company_ids: number[]; batch?: Batch },
  lookupInInstantly: ((emails: string[]) => Promise<string[]>) | null,
): Promise<AddPreview> {
  const ids = [...new Set(input.company_ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 5000)
  const batch: Batch = input.batch === 'role-inbox' ? 'role-inbox' : 'standard'
  const rs = await ruleSetForCampaign(q, input.campaign_id)
  const verdicts = (await evaluateCompanies(q, rs, ids)).filter((v) => v.contact_id != null)
  const { rows } = await q.query<Chosen>(CHOSEN, [verdicts.map((v) => v.contact_id)])
  const byContact = new Map(rows.map((r) => [Number(r.contact_id), r]))
  const emailRuleIds = new Set(rs.requirements.filter((r) => r.field === 'contact.verification_status').map((r) => r.id))
  const emails = verdicts.filter((v) => isReady(v.tier) && v.batch === batch).map((v) => byContact.get(v.contact_id!)?.email_norm).filter((e): e is string => Boolean(e))
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
  const leads: PreviewLead[] = []
  for (const v of verdicts) {
    const r = byContact.get(v.contact_id!)
    if (!r) continue
    let excluded: ExcludeReason | null = null
    if (!isReady(v.tier)) excluded = excludeFor(v, emailRuleIds)
    else if (v.batch !== batch) excluded = v.batch === 'role-inbox' ? 'role_inbox_batch' : 'not_role_inbox'
    else if (r.email_norm && inInstantly.has(r.email_norm)) excluded = 'in_instantly'
    leads.push({
      contact_id: Number(r.contact_id),
      company_id: Number(r.company_id),
      email: r.email,
      first_name: r.first_name,
      last_name: r.last_name,
      company: r.company,
      website: r.website,
      phone: r.phone,
      personalization: r.personalization,
      verification_status: r.verification_status,
      excluded,
      tier: v.tier,
      park_reasons: v.reasons.map((x) => `${x.label}: ${x.detail}`),
      merge: v.merge,
    })
  }
  return {
    campaign_id: input.campaign_id,
    campaign_name: input.campaign_name ?? null,
    ready: leads.filter((l) => !l.excluded),
    excluded: leads.filter((l) => l.excluded),
    instantlyChecked: checked,
    instantlyNote: note,
    rules: { id: rs.id, name: rs.name, version: rs.version },
    batch,
  }
}

/**
 * Re-score the stored ready list under the campaign's rules as they are now.
 * A lead that stopped being Ready since the preview is dropped (never sent);
 * the ones still Ready get today's personalization values.
 */
export async function recheckReady(q: Queryable, campaignId: string, ready: PreviewLead[], batch: Batch = 'standard'): Promise<{ keep: PreviewLead[]; dropped: { contact_id: number; email: string | null; reasons: string[] }[] }> {
  if (!ready.length) return { keep: [], dropped: [] }
  const rs = await ruleSetForCampaign(q, campaignId)
  const verdicts = await evaluateCompanies(q, rs, ready.map((l) => l.company_id))
  const byCompany = new Map<number, LeadVerdict>(verdicts.map((v) => [v.company_id, v]))
  const keep: PreviewLead[] = []
  const dropped: { contact_id: number; email: string | null; reasons: string[] }[] = []
  for (const l of ready) {
    const cv = byCompany.get(l.company_id)?.contacts.find((c) => c.contact_id === l.contact_id)
    if (cv && isReady(cv.tier) && cv.batch === batch) keep.push({ ...l, tier: cv.tier, merge: cv.merge })
    else dropped.push({ contact_id: l.contact_id, email: l.email, reasons: cv ? cv.reasons.map((x) => `${x.label}: ${x.detail}`) : ['lead no longer exists'] })
  }
  return { keep, dropped }
}

export type ActionStatus =
  | 'preview'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'sending'
  | 'done'
  | 'failed'
  | 'unknown'
  | 'cancelled'

export interface ActionRow {
  id: number
  kind: 'add_leads' | 'pause' | 'resume'
  campaign_id: string
  campaign_name: string | null
  contact_ids: number[]
  status: ActionStatus
  preview: AddPreview | null
  result: Record<string, unknown> | null
  error: string | null
  created_by: string | null
  confirmed_by: string | null
  created_at: string
  finished_at: string | null
  approval_id?: number | null
  requested_reason?: string | null
  decided_by?: string | null
  decision_note?: string | null
}

/** Thrown when anyone but an active human tries to send a change to Instantly. */
export class NotHumanError extends Error {
  readonly status = 403
  constructor(actor: string) {
    super(`Only a signed-in human can send changes to Instantly ('${actor}' is not one). Agents queue changes for approval.`)
    this.name = 'NotHumanError'
  }
}

export async function assertHuman(q: Queryable, actor: string): Promise<void> {
  const { rows } = await q.query<{ kind: string; active: boolean }>('select kind, active from lp.actors where id = $1', [actor])
  if (!rows[0] || rows[0].kind !== 'human' || !rows[0].active) throw new NotHumanError(actor)
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

export function toAddLead(l: PreviewLead, batch: Batch = 'standard'): AddLead {
  const out: AddLead = { email: (l.email ?? '').trim() }
  if (l.first_name) out.first_name = l.first_name
  if (l.last_name) out.last_name = l.last_name
  if (l.company) out.company_name = l.company
  if (l.website) out.website = l.website
  if (l.phone) out.phone = l.phone
  if (l.personalization) out.personalization = l.personalization
  const vars: Record<string, string> = { ...(l.merge ?? {}) }
  // Role-inbox batches are tagged so their replies are tracked apart.
  if (batch === 'role-inbox') vars.tab_batch = 'role-inbox'
  if (Object.keys(vars).length) out.custom_variables = vars
  return out
}

/**
 * Atomically move a row to 'sending'. Returns null when it was not in the
 * expected state any more. 'preview' is the human's own Add-to-Instantly flow;
 * 'approved' is an agent's request a human just approved (lib/instantly/gate.ts).
 */
async function claim(db: Db, id: number, actor: string, from: 'preview' | 'approved'): Promise<ActionRow | null> {
  const { rows } = await db.query<ActionRow>(
    `update lp.instantly_actions set status = 'sending', confirmed_by = $2, confirmed_at = now()
      where id = $1 and status = $3 and kind = 'add_leads' returning *`,
    [id, actor, from],
  )
  return rows[0] ?? null
}

export interface ConfirmOutcome {
  action: ActionRow
  sent: boolean
  message: string
}

export async function confirmAddLeads(
  db: Db,
  writer: InstantlyWriter,
  id: number,
  actor: string,
  opts: { from?: 'preview' | 'approved' } = {},
): Promise<ConfirmOutcome> {
  await assertHuman(db, actor)
  const row = await claim(db, id, actor, opts.from ?? 'preview')
  if (!row) {
    const existing = await getAction(db, id)
    if (!existing) throw new Error('That preview does not exist.')
    return { action: existing, sent: false, message: `Already ${existing.status}; nothing was sent again.` }
  }
  // Only Ready leads are ever sent: re-check under the campaign's rules as they are now.
  const batch: Batch = row.preview?.batch === 'role-inbox' ? 'role-inbox' : 'standard'
  const recheck = await recheckReady(db, row.campaign_id, (row.preview?.ready ?? []).filter((l) => l.email), batch)
  const ready = recheck.keep
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
      results.push(await writer.addLeads(row.campaign_id, chunk.map((l) => toAddLead(l, batch))))
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
    dropped_not_ready: recheck.dropped,
    batch,
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
        `insert into lp.campaign_touches (contact_id, company_id, email, campaign_id, campaign_name, event_type, source, external_id, payload)
         select c.id, c.company_id, c.email, $2, $3, 'added_to_campaign', 'dashboard', 'instantly_action:' || $4 || ':' || c.id, jsonb_build_object('batch', $5::text)
           from lp.contacts c where c.id = any($1::bigint[])`,
        [sentIds, row.campaign_id, row.campaign_name, String(id), batch],
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
        : `Added leads to ${what}: ${ready.length} sent${anyCount ? `, Instantly took ${uploaded}` : ''}${recheck.dropped.length ? `; ${recheck.dropped.length} left out (no longer Ready under the campaign's rules)` : ''}`,
      entity_type: 'campaign',
      entity_id: row.campaign_id,
      data: row.approval_id ? { ...summary, approval_id: row.approval_id, requested_by: row.created_by } : summary,
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
  await assertHuman(db, actor)
  const { rows } = await db.query<ActionRow>(
    `insert into lp.instantly_actions (kind, campaign_id, campaign_name, status, created_by, confirmed_by, confirmed_at)
     values ($1, $2, $3, 'sending', $4, $4, now()) returning *`,
    [input.kind, input.campaign_id, input.campaign_name ?? null, actor],
  )
  return runSwitch(db, writer, actor, rows[0])
}

/**
 * Run an agent's pause/resume request that a human just approved: the row
 * moves 'approved' -> 'sending' (only once; a second call is a no-op).
 */
export async function runApprovedSwitch(
  db: Db,
  writer: InstantlyWriter,
  actor: string,
  id: number,
): Promise<{ ok: boolean; message: string; action: ActionRow }> {
  await assertHuman(db, actor)
  const { rows } = await db.query<ActionRow>(
    `update lp.instantly_actions set status = 'sending', confirmed_by = $2, confirmed_at = now()
      where id = $1 and status = 'approved' and kind in ('pause', 'resume') returning *`,
    [id, actor],
  )
  if (!rows[0]) {
    const existing = await getAction(db, id)
    if (!existing) throw new Error('That Instantly change does not exist.')
    return { ok: false, message: `Already ${existing.status}; nothing was sent again.`, action: existing }
  }
  return runSwitch(db, writer, actor, rows[0])
}

async function runSwitch(db: Db, writer: InstantlyWriter, actor: string, row: ActionRow): Promise<{ ok: boolean; message: string; action: ActionRow }> {
  const input = { kind: row.kind as 'pause' | 'resume', campaign_id: row.campaign_id, campaign_name: row.campaign_name }
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
      data: row.approval_id ? { approval_id: row.approval_id, requested_by: row.created_by } : undefined,
    })
    return r.rows[0]
  }, actor)
  return { ok: !err, message: err ? err.message : `${verb} ${name}. Instantly may take a minute to show it.`, action: out }
}
