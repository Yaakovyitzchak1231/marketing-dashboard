/**
 * Deterministic weighted variant assignment for A/B experiments.
 * The same lead always lands in the same variant (hash of
 * experiment:company:contact), so re-runs and retries never flip a lead.
 * Assignment rows are inserted idempotently.
 */
import { createHash } from 'node:crypto'
import type { Queryable } from '../db/types.ts'
import { ExperimentsError, getExperiment } from './store.ts'
import type { Experiment } from './types.ts'

/** Bucket a lead into 0..9999 from a stable hash. Pure, for tests. */
export function hashBucket(experimentId: number, companyId: number, contactId: number | null): number {
  const h = createHash('sha256')
    .update(`${experimentId}:${companyId}:${contactId ?? 0}`)
    .digest()
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

export function pickVariant(exp: Experiment, companyId: number, contactId: number | null): string {
  return variantForBucket(exp.config.variants, hashBucket(exp.id, companyId, contactId))
}

export interface Assignment {
  experiment_id: number
  company_id: number
  contact_id: number | null
  variant: string
  assigned_at: Date
  /** True when the row already existed (the lead was assigned before). */
  existing: boolean
}

/**
 * Assign a lead to a variant, persisting the row. If the experiment is
 * already decided, the lead goes straight to the winner.
 */
export async function assignVariant(
  db: Queryable,
  experimentId: number,
  companyId: number,
  contactId: number | null = null,
): Promise<Assignment> {
  if (!Number.isInteger(experimentId) || experimentId <= 0) throw new ExperimentsError('Bad experiment id.')
  if (!Number.isInteger(companyId) || companyId <= 0) throw new ExperimentsError('company_id must be a positive integer.')
  if (contactId != null && (!Number.isInteger(contactId) || contactId <= 0)) {
    throw new ExperimentsError('contact_id must be a positive integer.')
  }
  const exp = await getExperiment(db, experimentId)
  if (!exp) throw new ExperimentsError(`No experiment ${experimentId}.`, 404)
  if (exp.status === 'draft') throw new ExperimentsError('The experiment is still a draft; start it before assigning leads.')
  if (exp.status === 'paused') throw new ExperimentsError('The experiment is paused; resume it before assigning leads.')

  const variant = exp.status === 'decided' && exp.winner_variant ? exp.winner_variant : pickVariant(exp, companyId, contactId)
  const leadKey = `${companyId}:${contactId ?? 0}`
  const r = await db.query<Record<string, unknown>>(
    `insert into lp.experiment_assignments (experiment_id, company_id, contact_id, variant)
     values ($1, $2, $3, $4)
     on conflict (experiment_id, lead_key) do nothing
     returning assigned_at`,
    [experimentId, companyId, contactId, variant],
  )
  if (r.rows.length) {
    return {
      experiment_id: experimentId,
      company_id: companyId,
      contact_id: contactId,
      variant,
      assigned_at: new Date(String(r.rows[0].assigned_at)),
      existing: false,
    }
  }
  const cur = await db.query<Record<string, unknown>>(
    'select variant, assigned_at from lp.experiment_assignments where experiment_id = $1 and lead_key = $2',
    [experimentId, leadKey],
  )
  return {
    experiment_id: experimentId,
    company_id: companyId,
    contact_id: contactId,
    variant: String(cur.rows[0].variant),
    assigned_at: new Date(String(cur.rows[0].assigned_at)),
    existing: true,
  }
}

export async function getAssignment(
  q: Queryable,
  experimentId: number,
  companyId: number,
  contactId: number | null = null,
): Promise<Assignment | null> {
  const r = await q.query<Record<string, unknown>>(
    'select company_id, contact_id, variant, assigned_at from lp.experiment_assignments where experiment_id = $1 and lead_key = $2',
    [experimentId, `${companyId}:${contactId ?? 0}`],
  )
  if (!r.rows.length) return null
  return {
    experiment_id: experimentId,
    company_id: Number(r.rows[0].company_id),
    contact_id: r.rows[0].contact_id == null ? null : Number(r.rows[0].contact_id),
    variant: String(r.rows[0].variant),
    assigned_at: new Date(String(r.rows[0].assigned_at)),
    existing: true,
  }
}
