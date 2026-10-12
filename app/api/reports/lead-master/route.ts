/**
 * GET /api/reports/lead-master — the read-only Lead Master copy as CSV, for the signed-in human.
 * Editor or owner, the same level as the Sheet export on the Reports screen; the export row is
 * recorded under the signed-in person's own actor id.
 */
import { NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getDb } from '@/lib/db'
import { exportCsv, finishExport, startExport } from '@/lib/export/lead-master'

export const dynamic = 'force-dynamic'

export async function GET() {
  // Role check first, before the database is touched.
  let actor: string
  try {
    actor = await actorFor('editor')
  } catch (e) {
    return authDenied(e, { ok: false })
  }
  const db = getDb()
  if (!db) return NextResponse.json({ ok: false, error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const id = await startExport(db, actor, 'csv', 'download')
  try {
    const { csv, rows } = await exportCsv(db)
    await finishExport(db, id, rows, null)
    const day = new Date().toISOString().slice(0, 10)
    return new NextResponse(csv, {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="lead-master-copy-${day}.csv"`, 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    await finishExport(db, id, null, (e as Error).message)
    return NextResponse.json({ ok: false, error: 'The export failed; see the Reports screen for the reason.' }, { status: 500 })
  }
}
