/**
 * PATCH /api/leads/stage  {company_ids: number[], stage: Stage}
 *   -> 200 {updated, unchanged, missing}
 *   -> 400 {error} bad body · 503 {error} no DATABASE_URL
 * Human route (behind the login gate); the actor is the owner. History rows are
 * written by the database trigger; one plain-English event is logged.
 */
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { setStage } from '@/lib/leads/queries'
import { STAGES, type Stage } from '@/lib/leads/types'

export const dynamic = 'force-dynamic'

const MAX_IDS = 5000

export async function PATCH(req: Request) {
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const body = (await req.json().catch(() => null)) as { company_ids?: unknown; stage?: unknown } | null
  const ids = Array.isArray(body?.company_ids) ? body!.company_ids : null
  if (!ids || ids.length === 0 || ids.length > MAX_IDS || !ids.every((x) => Number.isSafeInteger(x) && (x as number) > 0)) {
    return NextResponse.json({ error: `company_ids must be 1 to ${MAX_IDS} positive integers.` }, { status: 400 })
  }
  if (typeof body?.stage !== 'string' || !(STAGES as readonly string[]).includes(body.stage)) {
    return NextResponse.json({ error: `stage must be one of: ${STAGES.join(', ')}.` }, { status: 400 })
  }
  const result = await setStage(db, ids as number[], body.stage as Stage, 'owner')
  return NextResponse.json(result)
}
