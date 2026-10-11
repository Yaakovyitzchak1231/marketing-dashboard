/**
 * Retention ops for agents (POST /api/ops {op, ...}) and the dashboard (as 'owner').
 * See lib/retention/store.ts.
 */
import type { Db } from '../db/types'
import { OpsError } from '../ops/core'
import { RetentionError, forgetContact, listRetentionPolicies, retentionPreview, retentionSweep, setRetentionPolicy } from './store'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof RetentionError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

function requireOwner(actor: string): void {
  if (actor !== 'owner') throw new OpsError('only the owner can do this (it removes someone\'s data)', 403)
}

const RAW: Record<string, Op> = {
  list_retention_policies: {
    args: '{}',
    run: (db) => listRetentionPolicies(db),
  },
  set_retention_policy: {
    args: '{event_category, keep_days: number|null}  -- owner only; null = keep forever',
    run: (db, actor, a) => {
      requireOwner(actor)
      return setRetentionPolicy(db, actor, { event_category: String(a.event_category ?? ''), keep_days: a.keep_days == null ? null : Number(a.keep_days) })
    },
  },
  forget_contact: {
    args: '{contact_id, confirm}  -- owner only; confirm must be the contact\'s own (normalized) email, or "forget" if it has none',
    run: (db, actor, a) => {
      requireOwner(actor)
      return forgetContact(db, actor, { contact_id: Number(a.contact_id), confirm: String(a.confirm ?? '') })
    },
  },
  retention_preview: {
    args: '{}  -- what a retention sweep would delete now, per category (touches; timeline_events only if opted in). Deletes nothing.',
    run: (db) => retentionPreview(db),
  },
  retention_sweep: {
    args: '{confirm: true, include_timeline?: boolean}  -- owner only; deletes raw events past their category\'s keep_days, and timeline history too only with include_timeline. Without confirm nothing is deleted (409): the owner reviews retention_preview and confirms each run.',
    run: (db, actor, a) => {
      requireOwner(actor)
      return retentionSweep(db, actor, { confirm: a.confirm === true || a.confirm === 'true', include_timeline: a.include_timeline === true || a.include_timeline === 'true' })
    },
  },
}

export const RETENTION_OPS: Record<string, Op> = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, { args: v.args, run: wrap(v.run) }]))
