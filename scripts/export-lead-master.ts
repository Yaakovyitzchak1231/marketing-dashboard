/**
 * Lead Master copy: write the lead database back out, read-only.
 *
 *   DATABASE_URL=postgres://... node --experimental-strip-types scripts/export-lead-master.ts --csv lead_master_copy.csv
 *   DATABASE_URL=postgres://... LEAD_MASTER_SHEET_ID=<sheet id> GOOGLE_SERVICE_ACCOUNT_JSON='{...}' \
 *     node --experimental-strip-types scripts/export-lead-master.ts --sheet [--tab "DB export (read-only)"]
 *
 * --sheet writes ONLY a tab whose name starts with "DB export" (created if
 * missing, fully overwritten each run). The Lead Master "Leads" tab and every
 * other tab are never read or changed. Idempotent: run it as often as you like
 * (see docs/phase2.md, "Scheduling the Lead Master copy").
 */
import { writeFileSync } from 'node:fs'
import pg from 'pg'
import type { Queryable } from '../lib/db/types.ts'
import { exportCsv, finishExport, startExport } from '../lib/export/lead-master.ts'
import { DEFAULT_EXPORT_TAB, tokenFromEnv, writeExportTab } from '../lib/export/sheets.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('Set DATABASE_URL.')
  const csvPath = arg('--csv')
  const toSheet = process.argv.includes('--sheet')
  if (!csvPath && !toSheet) throw new Error('Say where: --csv <file> and/or --sheet.')
  pg.types.setTypeParser(20, (v: string) => Number(v))
  const pool = new pg.Pool({ connectionString: url, max: 2, ssl: /supabase|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined })
  const q: Queryable = {
    async query<T>(text: string, params?: unknown[]) {
      const r = await pool.query(text, params as unknown[] | undefined)
      return { rows: r.rows as T[], rowCount: r.rowCount }
    },
  }
  try {
    if (csvPath) {
      const id = await startExport(q, 'system', 'csv', csvPath)
      try {
        const { csv, rows } = await exportCsv(q)
        writeFileSync(csvPath, csv)
        await finishExport(q, id, rows, null)
        console.log(`CSV: ${rows} rows -> ${csvPath}`)
      } catch (e) {
        await finishExport(q, id, null, (e as Error).message)
        throw e
      }
    }
    if (toSheet) {
      const sheetId = process.env.LEAD_MASTER_SHEET_ID?.trim()
      if (!sheetId) throw new Error('Set LEAD_MASTER_SHEET_ID.')
      const token = await tokenFromEnv(process.env)
      if (!token) throw new Error('Set GOOGLE_SERVICE_ACCOUNT_JSON (or GOOGLE_ACCESS_TOKEN for a one-off run).')
      const tab = arg('--tab') ?? process.env.LEAD_MASTER_EXPORT_TAB ?? DEFAULT_EXPORT_TAB
      const id = await startExport(q, 'system', 'sheet', `${sheetId} / ${tab}`)
      try {
        const r = await writeExportTab(q, { sheetId, tab, token, stamp: new Date().toISOString() })
        await finishExport(q, id, r.rows, null)
        console.log(`Sheet: ${r.rows} rows -> tab "${r.tab}"${r.created ? ' (created)' : ''}`)
      } catch (e) {
        await finishExport(q, id, null, (e as Error).message)
        throw e
      }
    }
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error(String((e as Error).message ?? e))
  process.exit(1)
})
