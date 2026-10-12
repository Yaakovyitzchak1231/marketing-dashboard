/**
 * Deterministic weighted variant assignment for A/B experiments.
 *
 * Identity. A lead is a company, the same identity the rest of the platform
 * uses (lp.campaign_leads is keyed (campaign_id, company_id); a contact is only
 * the person written to). One company has exactly one assignment per
 * experiment, whichever of its contacts the journey run is for: the hash and
 * the unique key are (experiment, company). Merges are followed: a merged
 * company or contact resolves to the surviving row, and an assignment made
 * before the merge (under the merged-away company) is honoured, so a person is
 * never split into two independent assignments.
 *
 * Eligibility. A lead that does not exist is an error (404). A lead that is
 * do-not-contact or has a live suppression is NOT assigned: the result says why.
 *
 * Assignment rows are inserted idempotently; a decided experiment routes new
 * leads straight to the winner.
 */
import { createHash } from 'node:crypto'
import type { Queryable } from '../db/types.ts'
import { ExperimentsError, getExperiment } from './store.ts'
import type { Experiment } from './types.ts'

/** Bucket a lead into 0..9999 from a stable hash of (experiment, company). Pure, for tests. */
export function hashBucket(experimentId: number, companyId: number): number {
  const h = createHash('sha256').update(`${experimentId}:${companyId}`).digest()
  return h.readUInt32BE(0) % 10000
}

/** Pick the variant for a bucket given weights. Pure, for tests. */
export function variantForBucket(
  variants: { key: string; weight: number }[],
  bucket: number,
): string {
  const total = variants.reduce((s, v) => s + v.weight, 0)
  let cursor = Math.floor((bucket / 10000) * total)
  for (const v of variants) {
    cursor -= v.weight
    if (cursor < 0) return v.key
  }
  return variants[variants.length - 1].key
}

export function pickVariant(exp: Experiment, companyId: number): string {
  return variantForBucket(exp.config.variants, hashBucket(exp.id, companyId))
}

export interface Assignment {
  experiment_id: number
  /** The surviving company (merges followed). */
  company_id: number
  contact_id: number | null
  variant: string
  assigned_at: Date
  /** True when the row already existed (the lead was assigned before). */
  existing: boolean
}

export type AssignBlock = 'do_not_contact' | 'suppressed'

export type AssignResult =
  | ({ assigned: true } & Assignment)
  | { assigned: false; reason: AssignBlock; experiment_id: number; company_id: number; contact_id: number | null }

const MAX_MERGE_HOPS = 20

interface ResolvedLead {
  company_id: number
  contact_id: number | null
  email_norm: string | null
  block: AssignBlock | null
}

/** A company, following merged_into to the surviving row. 404 when it does not exist. */
async function followCompany(q: Queryable, id: number): Promise<{ id: number; stage: string | null }> {
  let cur = id
  for (let hop = 0; ; hop++) {
    const { rows } = await q.query<Record<string, unknown>>('select id, merged_into, stage from lp.companies where id = $1', [cur])
    const co = rows[0]
    if (!co) throw new ExperimentsError(`No company ${cur}.`, 404)
    if (co.merged_into != null && hop < MAX_MERGE_HOPS) {
      cur = Number(co.merged_into)
      continue
    }
    return { id: Number(co.id), stage: co.stage == null ? null : String(co.stage) }
  }
}

/** Check and normalise the lead: existence, merges (followed to the survivor), do-not-contact, suppression. */
async function resolveLead(
  q: Queryable,
  campaignId: number,
  companyIdIn: number | null,
  contactIdIn: number | null,
): Promise<ResolvedLead> {
  let contactId: number | null = null
  let contactCompany: number | null = null
  let emailNorm: string | null = null
  let contactBlocked = false
  if (contactIdIn != null) {
    let id = contactIdIn
    for (let hop = 0; ; hop++) {
      const { rows } = await q.query<Record<string, unknown>>(
        'select id, company_id, merged_into, email_norm, do_not_contact, status from lp.contacts where id = $1',
        [id],
      )
      const c = rows[0]
      if (!c) throw new ExperimentsError(`No contact ${id}.`, 404)
      if (c.merged_into != null && hop < MAX_MERGE_HOPS) {
        id = Number(c.merged_into)
        continue
      }
      contactId = Number(c.id)
      contactCompany = c.company_id == null ? null : Number(c.company_id)
      emailNorm = c.email_norm == null ? null : String(c.email_norm)
      contactBlocked = c.do_not_contact === true || c.status === 'do-not-contact'
      break
    }
  }
  const startCompany = companyIdIn ?? contactCompany
  if (startCompany == null) throw new ExperimentsError('The contact has no company; give company_id.')
  const company = await followCompany(q, startCompany)
  if (companyIdIn != null && contactCompany != null && (await followCompany(q, contactCompany)).id !== company.id) {
    throw new ExperimentsError(`Contact ${contactIdIn} does not belong to company ${companyIdIn}.`)
  }
  const companyId = company.id
  const stage = company.stage
  let block: AssignBlock | null = null
  if (stage === 'do_not_contact' || contactBlocked) block = 'do_not_contact'
  else if (emailNorm) {
    const s = await q.query<{ s: boolean }>('select lp.is_suppressed($1, $2::bigint) as s', [emailNorm, campaignId])
    if (s.rows[0]?.s) block = 'suppressed'
  }
  return { company_id: companyId, contact_id: contactId, email_norm: emailNorm, block }
}

/** An assignment for this company or any company merged into it (so a merge cannot split a lead in two). */
async function findAssignment(q: Queryable, experimentId: number, companyId: number): Promise<Assignment | null> {
  const r = await q.query<Record<string, unknown>>(
    `with recursive cluster(id) as (
       select $2::bigint
       union
       select c.id from lp.companies c join cluster on c.merged_into = cluster.id
     )
     select company_id, contact_id, variant, assigned_at from lp.experiment_assignments
      where experiment_id = $1 and company_id in (select id from cluster)
      order by assigned_at, id limit 1`,
    [experimentId, companyId],
  )
  if (!r.rows.length) return null
  return {
    experiment_id: experimentId,
    company_id: companyId,
    contact_id: r.rows[0].contact_id == null ? null : Number(r.rows[0].contact_id),
    variant: String(r.rows[0].variant),
    assigned_at: new Date(String(r.rows[0].assigned_at)),
    existing: true,
  }
}

/**
 * Assign a lead to a variant, persisting the row. If the experiment is already
 * decided, a not-yet-assigned lead goes straight to the winner. Returns
 * {assigned: false, reason} for a do-not-contact or suppressed lead.
 */
export async function assignVariant(
  db: Queryable,
  experimentId: number,
  companyId: number | null,
  contactId: number | null = null,
): Promise<AssignResult> {
  if (!Number.isInteger(experimentId) || experimentId <= 0) throw new ExperimentsError('Bad experiment id.')
  if (companyId != null && (!Number.isInteger(companyId) || companyId <= 0)) {
    throw new ExperimentsError('company_id must be a positive integer.')
  }
  if (contactId != null && (!Number.isInteger(contactId) || contactId <= 0)) {
    throw new ExperimentsError('contact_id must be a positive integer.')
  }
  if (companyId == null && contactId == null) throw new ExperimentsError('Give company_id or contact_id.')
  const exp = await getExperiment(db, experimentId)
  if (!exp) throw new ExperimentsError(`No experiment ${experimentId}.`, 404)
  if (exp.status === 'draft') throw new ExperimentsError('The experiment is still a draft; start it before assigning leads.')
  if (exp.status === 'paused') throw new ExperimentsError('The experiment is paused; resume it before assigning leads.')

  const lead = await resolveLead(db, exp.campaign_id, companyId, contactId)
  if (lead.block) {
    return { assigned: false, reason: lead.block, experiment_id: experimentId, company_id: lead.company_id, contact_id: lead.contact_id }
  }
  const prior = await findAssignment(db, experimentId, lead.company_id)
  if (prior) return { assigned: true, ...prior }

  const variant = exp.status === 'decided' && exp.winner_variant ? exp.winner_variant : pickVariant(exp, lead.company_id)
  const r = await db.query<Record<string, unknown>>(
    `insert into lp.experiment_assignments (experiment_id, company_id, contact_id, variant)
     values ($1, $2, $3, $4)
     on conflict (experiment_id, company_id) do nothing
     returning assigned_at`,
    [experimentId, lead.company_id, lead.contact_id, variant],
  )
  if (r.rows.length) {
    return {
      assigned: true,
      experiment_id: experimentId,
      company_id: lead.company_id,
      contact_id: lead.contact_id,
      variant,
      assigned_at: new Date(String(r.rows[0].assigned_at)),
      existing: false,
    }
  }
  // Lost an insert race: the other writer's row is the assignment.
  const cur = await findAssignment(db, experimentId, lead.company_id)
  if (!cur) throw new ExperimentsError('Could not read back the assignment; retry.', 500)
  return { assigned: true, ...cur }
}

export async function getAssignment(
  q: Queryable,
  experimentId: number,
  companyId: number,
): Promise<Assignment | null> {
  return findAssignment(q, experimentId, companyId)
}
