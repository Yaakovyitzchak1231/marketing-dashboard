/** GET /api/verify/runs?limit=20 -> { runs } (newest first). Editor role or above: runs carry spend and estimates. */
import { NextResponse, type NextRequest } from 'next/server'
import { listRuns } from '@/lib/verify/runs'
import { actorFor } from '@/lib/auth/act'
import { dbOrNull, fail, notConnected, NO_STORE } from '../_shared'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    await actorFor('editor')
  } catch (e) {
    return fail(e)
  }
  const db = dbOrNull()
  if (!db) return notConnected()
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 20)
  try {
    return NextResponse.json({ runs: await listRuns(db, Number.isFinite(limit) ? limit : 20) }, { headers: NO_STORE })
  } catch (e) {
    return fail(e)
  }
}
