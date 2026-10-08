import pg from 'pg'
import type { Db, Queryable, QueryResult } from './types'

// bigint ids and numeric money come back as strings by default; every id here
// fits comfortably in a JS number, and costs are tiny decimals.
pg.types.setTypeParser(20, (v: string) => Number(v))
pg.types.setTypeParser(1700, (v: string) => Number(v))

function sslFor(url: string): pg.PoolConfig['ssl'] {
  if (/sslmode=disable/.test(url)) return undefined
  if (/sslmode=require|supabase\.co|pooler\.supabase/.test(url)) return { rejectUnauthorized: false }
  return undefined
}

export function createPgDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, ssl: sslFor(url), max: 5, idleTimeoutMillis: 10_000 })
  const db: Db = {
    async query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
      const r = await pool.query(text, params as unknown[] | undefined)
      return { rows: r.rows as T[], rowCount: r.rowCount }
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>, actor?: string): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('begin')
        if (actor) await client.query("select set_config('lp.actor', $1, true)", [actor])
        const q: Queryable = {
          async query<R>(text: string, params?: unknown[]) {
            const r = await client.query(text, params as unknown[] | undefined)
            return { rows: r.rows as R[], rowCount: r.rowCount }
          },
        }
        const out = await fn(q)
        await client.query('commit')
        return out
      } catch (e) {
        await client.query('rollback').catch(() => undefined)
        throw e
      } finally {
        client.release()
      }
    },
  }
  return db
}
