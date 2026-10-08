/** POST /api/verify/runs/:id/cancel -> { run } */
import { NextResponse } from 'next/server'
import { cancelRun } from '@/lib/verify/runs'
import { dbOrNull, fail, notConnected, NO_STORE, parseRunId } from '../../../_shared'

export const dynamic = 'force-dynamic'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = dbOrNull()
  if (!db) return notConnected()
  const id = parseRunId((await params).id)
  if (!id) return NextResponse.json({ error: 'Bad run id' }, { status: 400, headers: NO_STORE })
  try {
    return NextResponse.json({ run: await cancelRun(db, id, 'owner') }, { headers: NO_STORE })
  } catch (e) {
    return fail(e)
  }
}
