/**
 * Merge ops for agents (POST /api/ops {op, ...}) and the dashboard (as 'owner').
 * See lib/merge/candidates.ts and lib/merge/merge.ts for the actual logic.
 */
import type { Db } from '../db/types'
import { OpsError } from '../ops/core'
import { requireOwnerActor } from '../ops/actor-role'
import { findCandidates, type MergeEntity } from './candidates'
import { MergeError, merge as runMerge } from './merge'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof MergeError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

function requireEntity(v: unknown): MergeEntity {
  if (v === 'company' || v === 'contact') return v
  throw new OpsError('entity must be "company" or "contact"')
}

const RAW: Record<string, Op> = {
  merge_candidates: {
    args: '{entity: company|contact, limit?}  -- likely-duplicate pairs by recomputed domain/phone/name+address key (company) or email (contact)',
    run: (db, _actor, a) => findCandidates(db, requireEntity(a.entity), a.limit == null ? 50 : Number(a.limit)),
  },
  merge: {
    args: '{entity: company|contact, keep, merge, choices?: {field: "keep"|"merge"|value}}  -- owner only; moves events/membership/comments/sources/enrichment to `keep`, soft-deletes `merge`',
    run: async (db, actor, a) => {
      await requireOwnerActor(db, actor, 'only an owner can merge records')
      return runMerge(db, actor, {
        entity: requireEntity(a.entity),
        keep: Number(a.keep),
        merge: Number(a.merge),
        choices: (a.choices as Record<string, unknown>) ?? {},
      })
    },
  },
}

export const MERGE_OPS: Record<string, Op> = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, { args: v.args, run: wrap(v.run) }]))
