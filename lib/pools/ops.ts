/**
 * Pool ops for agents and the dashboard (POST /api/ops {op, ...}; lib/ops/dispatch.ts
 * spreads these in). Pools are rows in lp.pools (lib/pools/store.ts); listing is
 * open to any agent, creating/editing a pool is a person's call (an agent can
 * propose one in conversation, same as rules).
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { createPool, getPool, invalidatePoolsCache, listPools, PoolError, updatePool } from './store.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof PoolError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

async function requireHuman(db: Db, actor: string): Promise<void> {
  const { rows } = await db.query<{ kind: string }>('select kind from lp.actors where id = $1', [actor])
  if (!rows[0]) throw new OpsError(`Unknown actor ${actor}.`, 403)
  if (rows[0].kind !== 'human') throw new OpsError('Only a person can create or edit a pool.', 403)
}

export const POOL_OPS: Record<string, Op> = {
  list_pools: {
    args: '{include_inactive?}  -- every pool a campaign can use; read-only',
    run: (db, _actor, a) => listPools(db, { includeInactive: a.include_inactive === true || a.include_inactive === 'true' }),
  },
  create_pool: {
    args: '{label, id?, description?, sort?, active?}  -- owner only; id defaults to a slug from label',
    run: wrap(async (db, actor, a) => {
      await requireHuman(db, actor)
      const pool = await createPool(db, actor, {
        id: typeof a.id === 'string' ? a.id : undefined,
        label: String(a.label ?? ''),
        description: a.description == null ? null : String(a.description),
        sort: a.sort == null ? undefined : Number(a.sort),
        active: a.active == null ? undefined : a.active === true || a.active === 'true',
      }, 'ops_api')
      invalidatePoolsCache()
      return pool
    }),
  },
  update_pool: {
    args: '{id, label?, description?, sort?, active?}  -- owner only',
    run: wrap(async (db, actor, a) => {
      await requireHuman(db, actor)
      const id = String(a.id ?? '').trim()
      if (!id) throw new OpsError('id is required.')
      const existing = await getPool(db, id)
      if (!existing) throw new OpsError(`No pool "${id}".`, 404)
      const pool = await updatePool(db, id, {
        label: a.label == null ? undefined : String(a.label),
        description: a.description === undefined ? undefined : a.description === null ? null : String(a.description),
        sort: a.sort == null ? undefined : Number(a.sort),
        active: a.active == null ? undefined : a.active === true || a.active === 'true',
      }, actor, 'ops_api')
      invalidatePoolsCache()
      return pool
    }),
  },
}
