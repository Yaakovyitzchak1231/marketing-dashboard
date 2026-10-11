/**
 * POST /api/leads/segments/preview {definition} -> {counts: {companies, contacts, verified_sendable}, readback}
 * The advanced-filters drawer's live match count while a Standard/Behaviour
 * definition is still being edited (not yet saved or applied). Thin wrapper
 * over segment_preview (lib/ops/dispatch.ts) -- same op the segment builder
 * uses, so the count the drawer shows and the count /leads?f=... later shows
 * come from the same query.
 */
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

export const dynamic = 'force-dynamic'

function tableMissing(e: unknown): boolean {
  return /does not exist/i.test((e as Error)?.message ?? '')
}

export async function POST(req: Request) {
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const body = (await req.json().catch(() => null)) as { definition?: unknown } | null
  try {
    const result = await runOp(db, 'owner', 'segment_preview', { definition: body?.definition })
    return NextResponse.json(result)
  } catch (e) {
    if (tableMissing(e)) return NextResponse.json({ unavailable: true })
    if (e instanceof OpsError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
