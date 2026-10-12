/**
 * Action library ops for agents (POST /api/ops {op, ...} and the REST aliases
 * in lib/ops/dispatch.ts): list_actions, run_action, step_log. One spread
 * line in lib/ops/dispatch.ts.
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { ActionError, listActions } from './registry.ts'
import { listStepLog, runAction } from './execute.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof ActionError) throw new OpsError(e.message, e.status)
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

export const ACTION_OPS: Record<string, Op> = {
  list_actions: {
    args: '{}  -- every action in the library: key, label, description, args',
    run: wrap(async () => listActions()),
  },
  run_action: {
    args: '{action, args?, campaign_id?, step_key?, company_id?, contact_id?}  -- run one library action on a lead; always writes a step_log row',
    run: wrap((db, actor, a) => {
      if (typeof a.action !== 'string' || !a.action) throw new OpsError('action is required')
      const args = (a.args ?? {}) as Record<string, unknown>
      if (args !== null && typeof args !== 'object') throw new OpsError('args must be an object')
      return runAction(db, actor, a.action, args, {
        campaign_id: optInt(a.campaign_id, 'campaign_id'),
        step_key: typeof a.step_key === 'string' ? a.step_key : null,
        company_id: optInt(a.company_id, 'company_id'),
        contact_id: optInt(a.contact_id, 'contact_id'),
      })
    }),
  },
  step_log: {
    args: '{campaign_id?, company_id?, action?, limit?}  -- recent action executions, newest first',
    run: wrap((db, _actor, a) =>
      listStepLog(db, {
        campaign_id: optInt(a.campaign_id, 'campaign_id'),
        company_id: optInt(a.company_id, 'company_id'),
        action: typeof a.action === 'string' ? a.action : null,
        limit: a.limit == null ? 50 : Math.floor(Number(a.limit)),
      }),
    ),
  },
}
