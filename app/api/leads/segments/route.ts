/**
 * GET  /api/leads/segments            -> {segments: [{id, name, kind, entity}]}
 * POST /api/leads/segments {name, definition} -> {id, name}   (create_segment, kind=dynamic)
 * The Leads screen's advanced-filters drawer (plan 2.5): the "Saved segments"
 * tab's list, and "Save as segment". Human route (editor or owner); actor is the signed-in person. Thin
 * wrapper over the already-tested segment engine ops (lib/ops/dispatch.ts).
 */
import { NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getDb } from '@/lib/db'
import { runOp } from '@/lib/ops/dispatch'
import { listSegments } from '@/lib/segments/store'
import { OpsError } from '@/lib/ops/core'
import { isUndefinedTable } from '@/lib/db/errors'

export const dynamic = 'force-dynamic'

/** Only SQLSTATE 42P01 (table not migrated yet); a missing column/function is a real error and is rethrown. */
function tableMissing(e: unknown): boolean {
  return isUndefinedTable(e)
}

export async function GET() {
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  try {
    const segments = await listSegments(db, { includeArchived: false })
    return NextResponse.json({ segments: segments.map((s) => ({ id: s.id, name: s.name, kind: s.kind, entity: s.entity })) })
  } catch (e) {
    if (tableMissing(e)) return NextResponse.json({ segments: [], unavailable: true })
    throw e
  }
}

export async function POST(req: Request) {
  // A Viewer can read lists/segments but not create or change them.
  let actor: string
  try {
    actor = await actorFor('editor')
  } catch (e) {
    return authDenied(e)
  }
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const body = (await req.json().catch(() => null)) as { name?: unknown; definition?: unknown } | null
  if (typeof body?.name !== 'string' || !body.name.trim()) return NextResponse.json({ error: 'Name the segment.' }, { status: 400 })
  try {
    const seg = (await runOp(db, actor, 'create_segment', { name: body.name, entity: 'company', definition: body.definition })) as { id: number; name: string }
    return NextResponse.json({ id: seg.id, name: seg.name })
  } catch (e) {
    if (e instanceof OpsError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
