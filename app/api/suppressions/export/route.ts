import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { exportCsv } from '@/lib/suppressions/store'

export const dynamic = 'force-dynamic'

/** GET /api/suppressions/export[?reason=&campaign_id=&include_lifted=1] -> suppressions.csv, a plain download (no login gate change; middleware.ts covers this route the same as every other page). */
export async function GET(req: Request) {
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'The lead database is not connected.' }, { status: 503 })
  const sp = new URL(req.url).searchParams
  const csv = await exportCsv(db, {
    q: sp.get('q'),
    reason: sp.get('reason'),
    campaign_id: sp.get('campaign_id') ? Number(sp.get('campaign_id')) : null,
    include_lifted: sp.get('include_lifted') === '1',
  })
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="suppressions.csv"',
    },
  })
}
