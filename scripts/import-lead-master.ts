/**
 * Import the Lead Master Google Sheet into the lead database. Read-only on the Sheet.
 *
 *   DATABASE_URL=postgres://... node --experimental-strip-types scripts/import-lead-master.ts --csv leads.csv
 *   DATABASE_URL=postgres://... LEAD_MASTER_CSV_URL='https://docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=<gid>' \
 *     GOOGLE_ACCESS_TOKEN=<oauth token with drive.readonly> node --experimental-strip-types scripts/import-lead-master.ts
 *   add --dry-run to parse and count without writing.
 *
 * Idempotent: safe to run again; existing rows are matched, never duplicated or overwritten.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { csvObjects } from '../lib/leads/csv.ts'
import { importLeadRows } from '../lib/leads/import.ts'
import type { Db, Queryable } from '../lib/db/types.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function loadCsv(): Promise<string> {
  const file = arg('--csv')
  if (file) return readFileSync(file, 'utf8')
  const url = process.env.LEAD_MASTER_CSV_URL
  if (!url) throw new Error('Give --csv <file> or set LEAD_MASTER_CSV_URL.')
  const headers: Record<string, string> = {}
  if (process.env.GOOGLE_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.GOOGLE_ACCESS_TOKEN}`
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`Sheet export answered HTTP ${res.status}`)
  const text = await res.text()
  if (/^\s*<!doctype html|<html/i.test(text)) throw new Error('Got an HTML page instead of CSV (is the token or sharing right?)')
  return text
}

async function main() {
  const rows = csvObjects(await loadCsv())
  if (!rows.length || !('email' in rows[0])) throw new Error('No rows, or no "email" column in the header.')
  console.log(`parsed ${rows.length} rows`)
  if (process.argv.includes('--dry-run')) return

  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')
  pg.types.setTypeParser(20, (v: string) => Number(v))
  const pool = new pg.Pool({ connectionString: url, max: 2, ssl: /supabase|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined })
  const wrap = (c: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> }): Queryable => ({
    async query<T>(text: string, params?: unknown[]) {
      const r = await c.query(text, params)
      return { rows: r.rows as T[], rowCount: r.rowCount }
    },
  })
  const db: Db = {
    ...wrap(pool),
    async tx(fn, actor) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        if (actor) await client.query("select set_config('lp.actor', $1, true)", [actor])
        const out = await fn(wrap(client))
        await client.query('commit')
        return out
      } catch (e) {
        await client.query('rollback')
        throw e
      } finally {
        client.release()
      }
    },
  }
  const t0 = Date.now()
  const stats = await importLeadRows(db, rows, {
    actor: 'system',
    onProgress: (done, s) => console.log(`${done}/${rows.length}  companies +${s.companies_created} (matched ${s.companies_matched})  contacts +${s.contacts_created}`),
  })
  await db.query(
    "insert into lp.events (actor, kind, summary, data) values ('system', 'import.lead_master', $1, $2)",
    [`Imported the Lead Master: ${stats.contacts_created.toLocaleString('en-US')} new contacts, ${stats.companies_created.toLocaleString('en-US')} new companies (${stats.contacts_existing.toLocaleString('en-US')} already here)`, JSON.stringify(stats)],
  )
  console.log(JSON.stringify({ ...stats, seconds: Math.round((Date.now() - t0) / 1000) }, null, 2))
  await pool.end()
}

main().catch((e) => {
  console.error(`import failed: ${(e as Error).message}`)
  process.exit(1)
})
