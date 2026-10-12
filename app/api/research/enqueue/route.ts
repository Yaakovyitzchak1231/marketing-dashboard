import { NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getDb } from '@/lib/db'
import { enqueueResearch } from '@/lib/engine/jobs'
import { kickDelivery } from '@/lib/notify/kick'

export const dynamic = 'force-dynamic'

/**
 * POST /api/research/enqueue { company_ids: number[], assigned_to?: string }
 * -> { queued: [{company_id, task_id}], already: number[], missing: number[] }
 * One research_company task per company (Tab by default); a company with a live research task is reported in `already`.
 */
export async function POST(req: Request) {
  // Role check first (editor and above); the tasks are queued as the signed-in person.
  let actor: string
  try {
    actor = await actorFor('editor')
  } catch (e) {
    return authDenied(e)
  }
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'database not connected' }, { status: 503 })
  let body: { company_ids?: unknown; assigned_to?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'send JSON' }, { status: 400 })
  }
  const ids = Array.isArray(body.company_ids) ? body.company_ids.map(Number) : []
  if (!ids.length) return NextResponse.json({ error: 'company_ids is required' }, { status: 400 })
  const who = typeof body.assigned_to === 'string' && body.assigned_to ? body.assigned_to : 'tab'
  const result = await enqueueResearch(db, actor, ids, who)
  kickDelivery(db)
  return NextResponse.json(result)
}
