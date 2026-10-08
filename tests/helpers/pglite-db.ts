import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import type { Db, Queryable } from '@/lib/db/types'

const MIGRATIONS = join(__dirname, '..', '..', 'db', 'migrations')

/**
 * A fresh, real Postgres (PGlite, in-process WASM) with every migration
 * applied. Each call is an isolated database; nothing touches a network.
 */
export async function createTestDb(): Promise<Db & { close: () => Promise<void> }> {
  const pg = new PGlite({
    parsers: {
      20: (v: string) => Number(v),
      1700: (v: string) => Number(v),
    },
  })
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, f), 'utf8'))
  }
  const wrap = (runner: { query: PGlite['query'] }): Queryable => ({
    async query<T>(text: string, params?: unknown[]) {
      const r = await runner.query<T>(text, params as unknown[] | undefined)
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }
    },
  })
  const base = wrap(pg)
  return {
    query: base.query,
    async tx<T>(fn: (q: Queryable) => Promise<T>, actor?: string) {
      return pg.transaction(async (t) => {
        if (actor) await t.query("select set_config('lp.actor', $1, true)", [actor])
        return fn(wrap(t as unknown as { query: PGlite['query'] }))
      })
    },
    close: () => pg.close(),
  }
}
