/** GET /api/leads/event-types -> {event_types: [{key, label}]} -- the Behaviour tab's event picker. */
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  try {
    const { rows } = await db.query<{ key: string; label: string }>('select key, label from lp.event_types order by label')
    return NextResponse.json({ event_types: rows })
  } catch (e) {
    if (/does not exist/i.test((e as Error)?.message ?? '')) return NextResponse.json({ event_types: [], unavailable: true })
    throw e
  }
}
