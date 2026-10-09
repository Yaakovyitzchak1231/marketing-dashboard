/**
 * Load Lead Master rows into the lead database over HTTPS, so an agent never needs DATABASE_URL.
 *
 *   POST /api/ops/import/lead-master            body: CSV (text/csv) or {"rows": [...]} (JSON), optionally gzip
 *   POST /api/ops/import/lead-master?dry_run=1  same, counts only: runs inside a transaction and rolls back
 *   POST /api/ops/import/lead-master?mode=sync_status[&dry_run=1]
 *        one-way status catch-up: for contacts already in the database whose Sheet status
 *        differs, the Sheet's status is written (nothing else; no contacts created). Each
 *        change lands in status_history (changed_by = the agent) and one 'import.status_sync' event.
 *   GET  /api/ops/import/lead-master            how many contacts/companies are in the database now
 *
 * Auth: an agent token from OPS_AGENT_TOKENS ("Authorization: Bearer <token>"); a paused agent gets 423.
 * Idempotent: rows already in the database are matched (by email, then company
 * domain/phone/name), never duplicated or overwritten, so a chunk can be re-sent safely.
 * At most MAX_ROWS_PER_REQUEST rows per call; scripts/push-lead-master.ts sends a
 * whole CSV in chunks and resumes with --start.
 */
import { NextResponse } from 'next/server'
import { opsGate } from '@/lib/ops/gate'
import { ImportRequestError, MAX_ROWS_PER_REQUEST, importRowsOverHttp, parseImportBody } from '@/lib/leads/import-request'
import { syncContactStatuses } from '@/lib/leads/sync-status'

const MODES = ['import', 'sync_status'] as const

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const NO_STORE = { 'Cache-Control': 'no-store' }

function fail(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE })
}

function truthy(v: string | null): boolean {
  return v != null && /^(1|true|yes)$/i.test(v.trim())
}

export async function GET(req: Request) {
  const gate = await opsGate(req, { unauthorizedMessage: 'Missing or unknown token.' })
  if (!gate.ok) return gate.response
  const { db } = gate
  if (!db) return fail(503, 'The lead database is not connected (DATABASE_URL is not set).')
  try {
    const { rows } = await db.query<{ contacts: number; companies: number }>(
      'select (select count(*) from lp.contacts)::int as contacts, (select count(*) from lp.companies)::int as companies',
    )
    return NextResponse.json({ ok: true, ...rows[0], max_rows_per_request: MAX_ROWS_PER_REQUEST }, { headers: NO_STORE })
  } catch (e) {
    return fail(500, `Could not read the lead tables (have the migrations run?): ${(e as Error).message}`)
  }
}

export async function POST(req: Request) {
  const gate = await opsGate(req, { unauthorizedMessage: 'Missing or unknown token.' })
  if (!gate.ok) return gate.response
  const { agent, db } = gate
  if (!db) return fail(503, 'The lead database is not connected (DATABASE_URL is not set).')

  const url = new URL(req.url)
  const mode = (url.searchParams.get('mode')?.trim() || 'import') as (typeof MODES)[number]
  if (!MODES.includes(mode)) return fail(400, `Unknown mode "${mode}". Use one of: ${MODES.join(', ')}.`)
  let parsed: ReturnType<typeof parseImportBody>
  try {
    const body = new Uint8Array(await req.arrayBuffer())
    parsed = parseImportBody(body, {
      contentType: req.headers.get('content-type'),
      contentEncoding: req.headers.get('content-encoding'),
    })
  } catch (e) {
    if (e instanceof ImportRequestError) return fail(e.status, e.message)
    return fail(400, `Could not read the body: ${(e as Error).message}`)
  }
  const dryRun = truthy(url.searchParams.get('dry_run')) || parsed.dryRun === true
  const label = url.searchParams.get('label')?.slice(0, 80) || undefined

  const t0 = Date.now()
  if (mode === 'sync_status') {
    try {
      const stats = await syncContactStatuses(db, parsed.rows, { actor: agent, dryRun, label })
      return NextResponse.json(
        { ok: true, mode, dry_run: dryRun, actor: agent, stats, seconds: Math.round((Date.now() - t0) / 100) / 10 },
        { headers: NO_STORE },
      )
    } catch (e) {
      return fail(500, `Status sync stopped: ${(e as Error).message}. Nothing from this request was written (it runs in one transaction); re-sending it is safe.`)
    }
  }
  try {
    const stats = await importRowsOverHttp(db, parsed.rows, { actor: agent, dryRun, label })
    return NextResponse.json(
      { ok: true, dry_run: dryRun, actor: agent, stats, seconds: Math.round((Date.now() - t0) / 100) / 10 },
      { headers: NO_STORE },
    )
  } catch (e) {
    return fail(
      500,
      `Import stopped: ${(e as Error).message}. ${dryRun ? 'Nothing was written (dry run).' : 'Rows are written in batches of 500, so part of this chunk may be in; re-sending it is safe (matched rows are not duplicated).'}`,
    )
  }
}
