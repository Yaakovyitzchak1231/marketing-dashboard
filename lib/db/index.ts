import 'server-only'
import type { Db } from './types'
import { createPgDb } from './pg'

export type { Db, Queryable, QueryResult } from './types'

/**
 * The lead platform's database: plain Postgres reached through DATABASE_URL.
 *
 * Returns null when DATABASE_URL is not set, so every page can render an
 * honest "not connected" state (and CI can build with no secrets) instead of
 * crashing or inventing rows.
 */
const globalForDb = globalThis as unknown as { __lpDb?: Db }

export function getDb(): Db | null {
  const url = process.env.DATABASE_URL
  if (!url) return null
  if (!globalForDb.__lpDb) globalForDb.__lpDb = createPgDb(url)
  return globalForDb.__lpDb
}

export function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL)
}
