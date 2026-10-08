import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { enqueueResearch } from '@/lib/engine/jobs'

export const dynamic = 'force-dynamic'

/**
 * POST /api/research/enqueue { company_ids: number[], assigned_to?: string }
 * -> { queued: [{company_id, task_id}], already: number[], missing: number[] }
 * One research_company task per company (Tab by default); a company with a live research task is reported in `already`.
 */
export async function POST(req: Request) {
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
  return NextResponse.json(await enqueueResearch(db, 'owner', ids, who))
}
