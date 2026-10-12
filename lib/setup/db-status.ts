import type { Db } from '@/lib/db/types'
import { isUndefinedTable } from '@/lib/db/errors'

export interface DbStatus {
  connected: boolean
  reachable: boolean
  migrationsApplied: string[]
  contacts: number | null
  companies: number | null
  error: string | null
}

/** What the database holds right now: migrations applied and lead counts. Never throws. */
export async function readDbStatus(db: Db | null): Promise<DbStatus> {
  const out: DbStatus = { connected: Boolean(db), reachable: false, migrationsApplied: [], contacts: null, companies: null, error: null }
  if (!db) return out
  try {
    const m = await db.query<{ filename: string }>(
      "select filename from lp_schema_migrations order by filename",
    )
    out.reachable = true
    out.migrationsApplied = m.rows.map((r) => r.filename)
  } catch (e) {
    if (isUndefinedTable(e)) {
      out.reachable = true
      out.error = 'No tables yet: the migrations have not run. Redeploy the production deployment and they run during the build.'
    } else {
      out.error = 'The database did not answer. Check that the Neon database still exists in Vercel → Storage.'
    }
    return out
  }
  try {
    const c = await db.query<{ contacts: number; companies: number }>(
      'select (select count(*) from lp.contacts)::int as contacts, (select count(*) from lp.companies)::int as companies',
    )
    const row = c.rows[0]
    if (row) {
      out.contacts = row.contacts
      out.companies = row.companies
    }
  } catch {
    // tables not there yet; migrationsApplied says how far it got
  }
  return out
}
