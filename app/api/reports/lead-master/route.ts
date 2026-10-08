/** GET /api/reports/lead-master — the read-only Lead Master copy as CSV, for the signed-in human. */
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { exportCsv, finishExport, startExport } from '@/lib/export/lead-master'

export const dynamic = 'force-dynamic'

export async function GET() {
  const db = getDb()
  if (!db) return NextResponse.json({ ok: false, error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const id = await startExport(db, 'owner', 'csv', 'download')
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
