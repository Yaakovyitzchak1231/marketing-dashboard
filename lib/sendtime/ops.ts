/**
 * Send-time ops for agents (POST /api/ops {op, ...} and the REST aliases in
 * lib/ops/dispatch.ts): sendtime_window, sendtime_recompute. One spread line
 * in lib/ops/dispatch.ts.
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import {
  getSendWindow,
  leadKey,
  recomputeSendWindow,
  recomputeSendWindows,
  SendTimeError,
} from './analyze.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof SendTimeError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

function optInt(v: unknown, field: string): number | null {
  if (v == null || v === '') return null
  const n = Math.floor(Number(v))
  if (!Number.isInteger(n) || n <= 0) throw new OpsError(`${field} must be a positive integer`)
  return n
}

export const SENDTIME_OPS: Record<string, Op> = {
  sendtime_window: {
    args: '{company_id?, contact_id?}  -- the lead\u2019s optimal send window (computes and stores it when missing)',
    run: wrap(async (db, _actor, a) => {
      const key = leadKey(optInt(a.company_id, 'company_id'), optInt(a.contact_id, 'contact_id'))
      const existing = await getSendWindow(db, key)
      if (existing) return { window: existing, computed: false }
      const computed = await recomputeSendWindow(db, key)
      return { window: computed, computed: computed != null }
    }),
  },
  sendtime_recompute: {
    args: '{campaign_id?, limit?}  -- relearn send windows for leads with recent engagement',
    run: wrap((db, _actor, a) =>
      recomputeSendWindows(db, {
        campaign_id: optInt(a.campaign_id, 'campaign_id'),
        limit: a.limit == null ? 500 : Math.floor(Number(a.limit)),
      }),
    ),
  },
}
