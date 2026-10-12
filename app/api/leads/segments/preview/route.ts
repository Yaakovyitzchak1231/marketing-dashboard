/**
 * POST /api/leads/segments/preview {definition} -> {counts: {companies, contacts, verified_sendable}, readback}
 * The advanced-filters drawer's live match count while a Standard/Behaviour
 * definition is still being edited (not yet saved or applied). Thin wrapper
 * over segment_preview (lib/ops/dispatch.ts) -- same op the segment builder
 * uses, so the count the drawer shows and the count /leads?f=... later shows
 * come from the same query.
 */
import { NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getDb } from '@/lib/db'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'
import { isUndefinedTable } from '@/lib/db/errors'

export const dynamic = 'force-dynamic'

/** Only SQLSTATE 42P01 (table not migrated yet); a missing column/function is a real error and is rethrown. */
function tableMissing(e: unknown): boolean {
  return isUndefinedTable(e)
}

export async function POST(req: Request) {
  // A read-only count that happens to be a POST: any signed-in role passes here
  // (middleware still refuses viewers on every POST).
  let actor: string
  try {
    actor = await actorFor('viewer')
  } catch (e) {
    return authDenied(e)
  }
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const body = (await req.json().catch(() => null)) as { definition?: unknown } | null
  try {
    const result = await runOp(db, actor, 'segment_preview', { definition: body?.definition })
    return NextResponse.json(result)
  } catch (e) {
    if (tableMissing(e)) return NextResponse.json({ unavailable: true })
    if (e instanceof OpsError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
