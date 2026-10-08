/**
 * The Lead Master copy for agents and schedules.
 *
 *   GET  /api/ops/export/lead-master        -> CSV of the lead database (read-only)
 *   POST /api/ops/export/lead-master        -> rewrite the "DB export" tab of the Lead Master Sheet
 *
 * Auth: an agent token (OPS_AGENT_TOKENS) or, for Vercel Cron, CRON_SECRET
 * (Vercel sends "Authorization: Bearer <CRON_SECRET>"; cron calls are GET, so
 * GET with ?to=sheet runs the Sheet export too). Idempotent: every run is a full overwrite
 * of the export tab; the Leads tab is never touched.
 */
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { agentForToken, secretMatches } from '@/lib/ops/auth'
import { exportCsv, finishExport, startExport } from '@/lib/export/lead-master'
import { DEFAULT_EXPORT_TAB, tokenFromEnv, writeExportTab } from '@/lib/export/sheets'
import { logEvent } from '@/lib/ops/events'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function caller(req: Request): string | null {
  const agent = agentForToken(req.headers.get('authorization'))
  if (agent) return agent
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')
  return m && secretMatches(m[1].trim(), process.env.CRON_SECRET) ? 'system' : null
}

async function sheet(actor: string) {
  const db = getDb()
  if (!db) return NextResponse.json({ ok: false, error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const sheetId = process.env.LEAD_MASTER_SHEET_ID?.trim()
  let token: string | null = null
  try {
    token = await tokenFromEnv(process.env)
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 503 })
  }
  if (!sheetId || !token) return NextResponse.json({ ok: false, error: 'Set LEAD_MASTER_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON.' }, { status: 503 })
  const tab = process.env.LEAD_MASTER_EXPORT_TAB?.trim() || DEFAULT_EXPORT_TAB
  const id = await startExport(db, actor, 'sheet', `${sheetId} / ${tab}`)
  try {
    const r = await writeExportTab(db, { sheetId, tab, token, stamp: new Date().toISOString() })
    await finishExport(db, id, r.rows, null)
    await logEvent(db, { actor, kind: 'export.lead_master', summary: `Wrote the read-only Lead Master copy: ${r.rows} rows to tab "${r.tab}"` })
    return NextResponse.json({ ok: true, rows: r.rows, tab: r.tab, created: r.created }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    await finishExport(db, id, null, (e as Error).message)
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }
}

export async function GET(req: Request) {
  const who = caller(req)
  if (!who) return NextResponse.json({ ok: false, error: 'Missing or unknown token.' }, { status: 401 })
  if (new URL(req.url).searchParams.get('to') === 'sheet') return sheet(who)
  const db = getDb()
  if (!db) return NextResponse.json({ ok: false, error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const id = await startExport(db, who, 'csv', 'api')
  try {
    const { csv, rows } = await exportCsv(db)
    await finishExport(db, id, rows, null)
    return new NextResponse(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' } })
  } catch (e) {
    await finishExport(db, id, null, (e as Error).message)
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const who = caller(req)
  if (!who) return NextResponse.json({ ok: false, error: 'Missing or unknown token.' }, { status: 401 })
  return sheet(who)
}
