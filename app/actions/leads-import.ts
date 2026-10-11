'use server'

/**
 * Server actions for /leads/import (CSV map -> preview -> import, plan 1.13)
 * and the quick Add lead form on /leads. Always acts as the signed-in human
 * ('owner'), via 'ui' -- the same path an agent reaches through the
 * import_csv ops API call (lib/leads/import-ops.ts).
 */
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/db'
import { csvObjects } from '@/lib/leads/csv'
import { CsvImportError, runCsvImport, type ImportSummary } from '@/lib/leads/csv-import'
import { FieldError } from '@/lib/fields/store'

const ME = 'owner'

function db() {
  const d = getDb()
  if (!d) throw new Error('The lead database is not connected (DATABASE_URL is not set).')
  return d
}

type Fail = { ok: false; error: string }
function fail(e: unknown): Fail {
  if (e instanceof CsvImportError || e instanceof FieldError) return { ok: false, error: e.message }
  console.error('csv import failed', (e as Error).message)
  return { ok: false, error: "That didn't work. Try again." }
}

export interface ParsedCsv {
  headers: string[]
  sample: Record<string, string>[]
  rowCount: number
}

export async function parseCsvAction(csvText: string): Promise<({ ok: true } & ParsedCsv) | Fail> {
  try {
    const rows = csvObjects(csvText)
    if (!rows.length) return { ok: false, error: 'No data rows found. Check the file has a header row and at least one data row.' }
    return { ok: true, headers: Object.keys(rows[0]), sample: rows.slice(0, 5), rowCount: rows.length }
  } catch (e) {
    return fail(e)
  }
}

export interface ImportRequest {
  csv: string
  mapping: Record<string, string>
  pool?: string | null
  campaign_id?: number | null
}

export async function previewImportAction(req: ImportRequest): Promise<({ ok: true } & ImportSummary) | Fail> {
  try {
    const rows = csvObjects(req.csv)
    const summary = await runCsvImport(db(), rows, {
      mapping: req.mapping, pool: req.pool ?? null, campaign_id: req.campaign_id ?? null, actor: ME, via: 'ui', dryRun: true,
    })
    return { ok: true, ...summary }
  } catch (e) {
    return fail(e)
  }
}

export async function runImportAction(req: ImportRequest): Promise<({ ok: true } & ImportSummary) | Fail> {
  try {
    const rows = csvObjects(req.csv)
    const summary = await runCsvImport(db(), rows, {
      mapping: req.mapping, pool: req.pool ?? null, campaign_id: req.campaign_id ?? null, actor: ME, via: 'ui', dryRun: false,
    })
    revalidatePath('/leads')
    return { ok: true, ...summary }
  } catch (e) {
    return fail(e)
  }
}

const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}

/** The quick 'Add lead' form on /leads: one row through the same import pipeline
 *  (same dedupe, suppression check, and custom-field validation as a CSV import). */
export async function addLeadAction(f: FormData): Promise<({ ok: true } & ImportSummary) | Fail> {
  const row: Record<string, string> = {}
  for (const k of ['email', 'first_name', 'last_name', 'title', 'phone', 'company_name', 'website', 'company_phone', 'city', 'state']) {
    const v = s(f, k)
    if (v) row[k] = v
  }
  const identityMapping = Object.fromEntries(Object.keys(row).map((k) => [k, k]))
  const pool = s(f, 'pool') || null
  const campaignRaw = s(f, 'campaign_id')
  try {
    const summary = await runCsvImport(db(), [row], {
      mapping: identityMapping, pool, campaign_id: campaignRaw ? Number(campaignRaw) : null, actor: ME, via: 'ui', dryRun: false,
    })
    revalidatePath('/leads')
    return { ok: true, ...summary }
  } catch (e) {
    return fail(e)
  }
}
