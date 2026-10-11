/**
 * Data sources & sync health op (plan 1.11). See lib/sources/health.ts for
 * the per-source readers; this file is only the ops-table wiring
 * (lib/ops/dispatch.ts) and the UI's server component both call sourcesHealth
 * directly (it needs no auth beyond being signed in / holding an agent key —
 * read-only, nothing here is a secret).
 */
import type { Db } from '@/lib/db/types'
import { sourcesHealth } from '@/lib/sources/health'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

export const SOURCES_HEALTH_OPS: Record<string, Op> = {
  sources_health: {
    args: '{}  -> one row per data source: last event/sync, 24h volume (by type where it applies), error count, last error. null = no data yet, never a guessed number.',
    run: (db) => sourcesHealth(db),
  },
}
