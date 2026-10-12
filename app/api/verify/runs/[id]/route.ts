/** GET /api/verify/runs/:id -> { run }. Editor role or above: a run carries spend, estimates and per-lead tallies. */
import { NextResponse } from 'next/server'
import { getRun } from '@/lib/verify/runs'
import { actorFor } from '@/lib/auth/act'
import { dbOrNull, fail, notConnected, NO_STORE, parseRunId } from '../../_shared'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await actorFor('editor')
  } catch (e) {
    return fail(e)
  }
  const db = dbOrNull()
  if (!db) return notConnected()
  const id = parseRunId((await params).id)
  if (!id) return NextResponse.json({ error: 'Bad run id' }, { status: 400, headers: NO_STORE })
  try {
    const run = await getRun(db, id)
    if (!run) return NextResponse.json({ error: `No verification run #${id}` }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ run }, { headers: NO_STORE })
  } catch (e) {
    return fail(e)
  }
}
