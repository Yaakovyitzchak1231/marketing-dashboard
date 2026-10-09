/**
 * Lead Master rows sent over HTTP (POST /api/ops/import/lead-master), so an agent
 * can fill the database without ever holding DATABASE_URL.
 *
 * Bodies accepted (each optionally gzip-compressed, by Content-Encoding: gzip,
 * Content-Type: application/gzip, or just gzip bytes):
 *   - text/csv: a CSV with the Lead Master header row (email, status, first_name, ...)
 *   - application/json: { "rows": [ { "email": "...", ... }, ... ] } or a bare array
 * Vercel caps a request body at about 4.5 MB, so large sheets go in chunks
 * (scripts/push-lead-master.ts does that); MAX_ROWS_PER_REQUEST keeps each call
 * well inside the function's time limit.
 */
import { gunzipSync } from 'node:zlib'
import type { Db, Queryable } from '@/lib/db/types'
import { csvObjects } from './csv'
import { importLeadRows, type ImportStats } from './import'

export const MAX_ROWS_PER_REQUEST = 5000

export class ImportRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

/** gzip by its magic bytes (a proxy may already have decoded a Content-Encoding: gzip body). */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

function normalizeRow(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null) continue
    out[k.trim().toLowerCase()] = typeof v === 'string' ? v.trim() : String(v)
  }
  return out
}

/** Turn a request body into Lead Master row objects. Throws ImportRequestError with a status. */
export function parseImportBody(
  body: Uint8Array,
  headers: { contentType?: string | null; contentEncoding?: string | null },
): { rows: Record<string, string>[]; dryRun: boolean | null } {
  const contentType = (headers.contentType ?? '').toLowerCase()
  if (!body.length) throw new ImportRequestError(400, 'Empty body. Send a CSV (text/csv) or JSON ({"rows": [...]}).')
  let bytes = body
  if (isGzip(bytes)) {
    try {
      bytes = new Uint8Array(gunzipSync(bytes))
    } catch {
      throw new ImportRequestError(400, 'The body looked gzip-compressed but did not decompress.')
    }
  }
  const text = new TextDecoder('utf-8').decode(bytes)
  const trimmed = text.replace(/^\uFEFF/, '').trimStart()
  let rows: Record<string, string>[]
  let dryRun: boolean | null = null
  if (/json/.test(contentType) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new ImportRequestError(400, 'The body is not valid JSON.')
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown })?.rows
    if (!Array.isArray(list)) throw new ImportRequestError(400, 'JSON must be {"rows": [...]} or an array of rows.')
    if (!Array.isArray(parsed) && typeof (parsed as { dry_run?: unknown }).dry_run === 'boolean') dryRun = (parsed as { dry_run: boolean }).dry_run
    rows = []
    for (const r of list) {
      const n = normalizeRow(r)
      if (!n) throw new ImportRequestError(400, 'Every row must be an object of column -> value.')
      rows.push(n)
    }
  } else {
    rows = csvObjects(text)
    if (rows.length && !('email' in rows[0])) throw new ImportRequestError(400, 'The CSV header has no "email" column.')
  }
  if (!rows.length) throw new ImportRequestError(400, 'No rows in the body.')
  if (rows.length > MAX_ROWS_PER_REQUEST) {
    throw new ImportRequestError(413, `Too many rows in one request (${rows.length}); send at most ${MAX_ROWS_PER_REQUEST} per call.`)
  }
  return { rows, dryRun }
}

class DryRunRollback extends Error {}

/**
 * Upsert rows with the same rules as scripts/import-lead-master.ts (importLeadRows:
 * matched rows are never duplicated or overwritten). A dry run does the whole import
 * inside one transaction and rolls it back, so its counts are exactly what a real
 * run would do right now, and nothing is written.
 */
export async function importRowsOverHttp(
  db: Db,
  rows: Record<string, string>[],
  opts: { actor: string; dryRun: boolean; label?: string },
): Promise<ImportStats> {
  if (!opts.dryRun) {
    const stats = await importLeadRows(db, rows, { actor: opts.actor })
    await db.query(
      'insert into lp.events (actor, kind, summary, data) values ($1, $2, $3, $4)',
      [
        opts.actor,
        'import.lead_master',
        `Imported Lead Master rows${opts.label ? ` (${opts.label})` : ''} over the ops API: ${stats.contacts_created.toLocaleString('en-US')} new contacts, ${stats.companies_created.toLocaleString('en-US')} new companies (${stats.contacts_existing.toLocaleString('en-US')} already here)`,
        JSON.stringify(stats),
      ],
    )
    return stats
  }
  let result: ImportStats | null = null
  try {
    await db.tx(async (q: Queryable) => {
      const inner: Db = { query: (t, p) => q.query(t, p), tx: (fn) => fn(q) }
      result = await importLeadRows(inner, rows, { actor: opts.actor })
      throw new DryRunRollback('dry run')
    }, opts.actor)
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e
  }
  if (!result) throw new Error('dry run produced no result')
  return result
}
