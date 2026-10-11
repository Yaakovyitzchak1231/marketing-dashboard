import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { createFindJob, listFindJobs } from '@/lib/engine/jobs'
import { ParamsError } from '@/engine/params'
import { loadCities } from '@/engine/data'
import { STATE_ABBR } from '@/engine/parse/domains'
import { OpsError } from '@/lib/ops/core'
import { kickDelivery } from '@/lib/notify/kick'

export const dynamic = 'force-dynamic'

/** GET /api/find/jobs -> { jobs: FindJob[] } (newest first, 25). */
export async function GET() {
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'database not connected' }, { status: 503 })
  return NextResponse.json({ jobs: await listFindJobs(db) })
}

/**
 * POST /api/find/jobs { segment, states[] | cities[] | all_us, max_businesses, stages[], proxies, queries[]?, assigned_to? }
 * -> 201 { job }. Creates a find_leads task (assigned to Tab by default) as the signed-in owner.
 */
export async function POST(req: Request) {
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'database not connected' }, { status: 503 })
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'send JSON' }, { status: 400 })
  }
  // A city outside the top-1000 list has no map coordinates, so the engine
  // would search nothing. Say so now instead of running an empty job.
  const asked = body && typeof body === 'object' ? (body as { cities?: unknown }).cities : undefined
  const askedCities = Array.isArray(asked) ? asked.map(String) : typeof asked === 'string' ? asked.split(/[;\n]/) : []
  if (askedCities.length) {
    let known: Set<string> | null = null
    try {
      known = new Set(loadCities(STATE_ABBR).map((c) => `${c.city}, ${c.state}`.toLowerCase()))
    } catch {
      known = null // data file not bundled here; the runner will report it instead
    }
    const missing = known ? askedCities.map((c) => c.trim()).filter((c) => c && !known!.has(c.replace(/\s*,\s*/, ', ').toLowerCase())) : []
    if (missing.length) {
      return NextResponse.json(
        { error: `Not in the city list (top 1,000 US cities): ${missing.join('; ')}. Pick the state instead, or a nearby listed city.` },
        { status: 400 },
      )
    }
  }
  try {
    const job = await createFindJob(db, 'owner', body)
    kickDelivery(db)
    return NextResponse.json({ job }, { status: 201 })
  } catch (e) {
    if (e instanceof ParamsError) return NextResponse.json({ error: e.message }, { status: 400 })
    if (e instanceof OpsError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
