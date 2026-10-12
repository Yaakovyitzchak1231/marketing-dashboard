/**
 * POST /api/verify/runs/:id/approve { max_cost_usd: number }
 * The explicit human click: approves a previewed run with a dollar ceiling
 * (or raises the ceiling of a paused run). Actor: 'owner' (behind the login gate).
 * -> { run }
 */
import { NextResponse } from 'next/server'
import { approveRun } from '@/lib/verify/runs'
import { actorFor } from '@/lib/auth/act'
import { dbOrNull, fail, notConnected, NO_STORE, parseRunId, readJson } from '../../../_shared'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = dbOrNull()
  if (!db) return notConnected()
  const id = parseRunId((await params).id)
  if (!id) return NextResponse.json({ error: 'Bad run id' }, { status: 400, headers: NO_STORE })
  const body = await readJson(req)
  const max = typeof body.max_cost_usd === 'number' ? body.max_cost_usd : Number(body.max_cost_usd)
  if (body.max_cost_usd == null || !Number.isFinite(max)) {
    return NextResponse.json({ error: 'max_cost_usd is required' }, { status: 400, headers: NO_STORE })
  }
  try {
    const actor = await actorFor('owner')
    return NextResponse.json({ run: await approveRun(db, id, max, actor) }, { headers: NO_STORE })
  } catch (e) {
    return fail(e)
  }
}
