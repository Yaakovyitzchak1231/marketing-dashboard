/**
 * Instantly reconcile op (plan 1.6): the runner job 'instantly_reconcile' and,
 * for an on-demand catch-up, the owner can call it directly from the
 * dashboard. The logic lives in lib/instantly/reconcile.ts; this file is only
 * the ops-table wiring (lib/ops/dispatch.ts).
 *
 * client.ts (and everything reconcile.ts needs from it) is 'server-only', and
 * lib/ops/dispatch.ts is imported by test files and non-server code that must
 * stay importable without a server-only guard tripping — so, like the
 * existing Instantly gate/lookups ops in dispatch.ts, both are loaded lazily
 * inside the op's run(), never at this module's top level.
 */
import type { Db } from '@/lib/db/types'
import { OpsError } from '@/lib/ops/core'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

export const INSTANTLY_RECONCILE_OPS: Record<string, Op> = {
  instantly_reconcile_run: {
    args: "{since_days?}  -- the runner (actor 'system') or the owner only; pulls per-lead Instantly activity and inserts any lp.lead_events the webhook missed",
    run: async (db, actor, a) => {
      if (actor !== 'system' && actor !== 'owner') throw new OpsError('only the runner or the owner can run the Instantly reconcile', 403)
      const [{ clientFromConfig }, { reconcileInstantly }] = await Promise.all([import('@/lib/instantly/client'), import('@/lib/instantly/reconcile')])
      const client = await clientFromConfig()
      if (!client) throw new OpsError('no Instantly API key is configured (Settings → Integrations)', 409)
      const sinceDays = a.since_days == null ? undefined : Number(a.since_days)
      if (sinceDays !== undefined && (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 365)) {
        throw new OpsError('since_days must be a whole number of days from 1 to 365')
      }
      return reconcileInstantly(db, client, { sinceDays })
    },
  },
}
