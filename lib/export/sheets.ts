/**
 * Writes the Lead Master copy into its own tab of a Google Sheet, through the
 * plain Sheets REST API (no SDK). Guarded so it can only ever touch a tab named
 * "DB export…": the Lead Master "Leads" tab and every other tab are refused
 * before any request is made.
 *
 * Auth, in order: GOOGLE_SERVICE_ACCOUNT_JSON (a service account the Sheet is
 * shared with as Editor; signs its own short-lived token, so it works on a
 * schedule) or GOOGLE_ACCESS_TOKEN (an OAuth token, ~1 hour; fine for a manual
 * run). Free: the Sheets API costs nothing at this volume.
 */
import { createSign } from 'node:crypto'
import { EXPORT_COLUMNS, exportRows, type ExportRow } from './lead-master.ts'
import type { Queryable } from '../db/types.ts'

export const EXPORT_TAB_PREFIX = 'DB export'
export const DEFAULT_EXPORT_TAB = 'DB export (read-only)'
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'

export class SheetExportError extends Error {}

export function assertExportTab(tab: string): string {
  const t = tab.trim()
  if (!t.startsWith(EXPORT_TAB_PREFIX)) {
    throw new SheetExportError(`Refusing to write to tab "${t}": the export only writes tabs whose name starts with "${EXPORT_TAB_PREFIX}". Lead Master tabs are never touched.`)
  }
  if (t.length > 100 || /['!]/.test(t)) throw new SheetExportError('Export tab names cannot contain quotes or "!".')
  return t
}

export function assertSheetId(id: string): string {
  const s = id.trim()
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(s)) throw new SheetExportError('That does not look like a Google Sheet id.')
  return s
}

const b64url = (b: Buffer | string) => (typeof b === 'string' ? Buffer.from(b, 'utf8') : b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

/** Service-account JWT -> access token (RS256 with node:crypto; no SDK). */
export async function serviceAccountToken(json: string, fetchImpl: typeof fetch = fetch, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  let sa: { client_email?: string; private_key?: string; token_uri?: string }
  try {
    sa = JSON.parse(json)
  } catch {
    throw new SheetExportError('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.')
  }
  if (!sa.client_email || !sa.private_key) throw new SheetExportError('GOOGLE_SERVICE_ACCOUNT_JSON needs client_email and private_key.')
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token'
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(
    JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud, iat: nowSec, exp: nowSec + 3600 }),
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${head}.${claim}`)
  const sig = b64url(signer.sign(sa.private_key))
  const res = await fetchImpl(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }).toString(),
  })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string }
  if (!res.ok || !body.access_token) throw new SheetExportError(`Google refused the service account (${body.error_description ?? body.error ?? res.status}).`)
  return body.access_token
}

export async function tokenFromEnv(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()) return serviceAccountToken(env.GOOGLE_SERVICE_ACCOUNT_JSON, fetchImpl)
  if (env.GOOGLE_ACCESS_TOKEN?.trim()) return env.GOOGLE_ACCESS_TOKEN.trim()
  return null
}

export function sheetExportConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.LEAD_MASTER_SHEET_ID?.trim() && (env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim() || env.GOOGLE_ACCESS_TOKEN?.trim()))
}

async function call(fetchImpl: typeof fetch, token: string, url: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const msg = (j.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`
    throw new SheetExportError(`Google Sheets refused the export (${String(msg).slice(0, 200)}).`)
  }
  return j
}

export interface SheetExportResult {
  sheetId: string
  tab: string
  rows: number
  created: boolean
}

/**
 * Full overwrite of the export tab: create it if missing, clear it, write the
 * header and every row in 5,000-row batches. Idempotent.
 */
export async function writeExportTab(
  q: Queryable,
  opts: { sheetId: string; tab?: string; token: string; fetchImpl?: typeof fetch; stamp?: string },
): Promise<SheetExportResult> {
  const f = opts.fetchImpl ?? fetch
  const sheetId = assertSheetId(opts.sheetId)
  const tab = assertExportTab(opts.tab ?? DEFAULT_EXPORT_TAB)
  const meta = await call(f, opts.token, `${SHEETS}/${sheetId}?fields=sheets.properties(sheetId,title)`, 'GET')
  const sheets = ((meta.sheets as { properties: { title: string } }[] | undefined) ?? []).map((s) => s.properties.title)
  let created = false
  if (!sheets.includes(tab)) {
    await call(f, opts.token, `${SHEETS}/${sheetId}:batchUpdate`, 'POST', { requests: [{ addSheet: { properties: { title: tab } } }] })
    created = true
  }
  const range = (a1: string) => encodeURIComponent(`'${tab}'!${a1}`)
  await call(f, opts.token, `${SHEETS}/${sheetId}/values/${range('A:ZZ')}:clear`, 'POST', {})
  const header = [...EXPORT_COLUMNS] as string[]
  await call(f, opts.token, `${SHEETS}/${sheetId}/values/${range('A1')}?valueInputOption=RAW`, 'PUT', {
    values: [header],
  })
  let row = 2
  let total = 0
  for await (const page of exportRows(q)) {
    const values = page.map((r: ExportRow) => EXPORT_COLUMNS.map((c) => r[c]))
    await call(f, opts.token, `${SHEETS}/${sheetId}/values/${range(`A${row}`)}?valueInputOption=RAW`, 'PUT', { values })
    row += values.length
    total += values.length
  }
  if (opts.stamp) {
    const col = String.fromCharCode(65 + header.length + 1) // one blank column after the data
    await call(f, opts.token, `${SHEETS}/${sheetId}/values/${range(`${col}1`)}?valueInputOption=RAW`, 'PUT', {
      values: [[`Read-only copy of the lead database, written ${opts.stamp}. Edits here are overwritten by the next export.`]],
    })
  }
  return { sheetId, tab, rows: total, created }
}
