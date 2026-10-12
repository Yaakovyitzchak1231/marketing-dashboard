/**
 * POST /api/verify/runs/:id/step { chunk?: number (default 20), concurrency?: number (default 4) }
 * Processes the next chunk of an approved run through the waterfall. Refuses
 * to start a contact whose worst-case cost could cross the approved ceiling.
 * -> { run, processed_now, spent_now_usd, done, paused, halted }
 */
import { NextResponse } from 'next/server'
import { stepRun, verifyEnvFromConfig } from '@/lib/verify/runs'
import { actorFor } from '@/lib/auth/act'
import { dbOrNull, fail, notConnected, NO_STORE, parseRunId, readJson } from '../../../_shared'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

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
  const chunk = body.chunk == null ? undefined : Number(body.chunk)
  const concurrency = body.concurrency == null ? undefined : Number(body.concurrency)
  try {
    const env = await verifyEnvFromConfig()
    const report = await stepRun(db, id, env, {
      chunk: Number.isFinite(chunk) ? chunk : undefined,
      concurrency: Number.isFinite(concurrency) ? concurrency : undefined,
      timeBudgetMs: 40_000,
      // The person running this step, not whoever approved the run.
      actor,
    })
    return NextResponse.json(report, { headers: NO_STORE })
  } catch (e) {
    return fail(e)
  }
}
