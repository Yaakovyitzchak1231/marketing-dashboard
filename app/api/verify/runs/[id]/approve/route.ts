/**
 * POST /api/verify/runs/:id/approve { max_cost_usd: number }
 * The explicit human click: approves a previewed run with a dollar ceiling
 * (or raises the ceiling of a paused run). Owner role only; the approval is
 * recorded under the signed-in owner's own actor id.
 * A ceiling above $500 also needs `confirm_high_spend: true` (400 without it).
 * -> { run }
 */
import { NextResponse } from 'next/server'
import { approveRun } from '@/lib/verify/runs'
import { HIGH_SPEND_CONFIRM_USD } from '@/lib/verify/pricing'
import { actorFor } from '@/lib/auth/act'
import { dbOrNull, fail, notConnected, NO_STORE, parseRunId, readJson } from '../../../_shared'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Role check first: a non-owner learns nothing about validation, the database or the run.
  let actor: string
  try {
    actor = await actorFor('owner')
  } catch (e) {
    return fail(e)
  }
  const db = dbOrNull()
  if (!db) return notConnected()
  const id = parseRunId((await params).id)
  if (!id) return NextResponse.json({ error: 'Bad run id' }, { status: 400, headers: NO_STORE })
  const body = await readJson(req)
  const max = typeof body.max_cost_usd === 'number' ? body.max_cost_usd : Number(body.max_cost_usd)
  if (body.max_cost_usd == null || !Number.isFinite(max)) {
    return NextResponse.json({ error: 'max_cost_usd is required' }, { status: 400, headers: NO_STORE })
  }
  if (max > HIGH_SPEND_CONFIRM_USD && body.confirm_high_spend !== true) {
    return NextResponse.json(
      {
        error: `A ceiling above $${HIGH_SPEND_CONFIRM_USD} needs confirmation. Send confirm_high_spend: true if you mean to allow up to $${max}.`,
      },
      { status: 400, headers: NO_STORE },
    )
  }
  try {
    return NextResponse.json({ run: await approveRun(db, id, max, actor) }, { headers: NO_STORE })
  } catch (e) {
    return fail(e)
  }
}
