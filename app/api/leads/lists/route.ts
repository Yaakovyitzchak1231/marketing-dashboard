/**
 * GET  /api/leads/lists                              -> {lists: [{id, name}]}
 * POST /api/leads/lists {company_ids, list_id? | new_list_name?}
 *   -> 200 {list: {id, name}, added}
 *   -> 400 {error} bad body · 404/409 {error} from the segment engine · 503 {error} no DATABASE_URL
 * The bulk bar's "Add to list..." (plan 2.4). Human route (editor or owner); actor is the signed-in person.
 */
import { NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getDb } from '@/lib/db'
import { listStaticLists, addCompaniesToList, ListsError } from '@/lib/segments/lists'
import { OpsError } from '@/lib/ops/core'
import { isUndefinedTable } from '@/lib/db/errors'

export const dynamic = 'force-dynamic'
const MAX_IDS = 5000

/** Only SQLSTATE 42P01 (table not migrated yet); a missing column/function is a real error and is rethrown. */
function tableMissing(e: unknown): boolean {
  return isUndefinedTable(e)
}

export async function GET() {
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  try {
    const lists = await listStaticLists(db)
    return NextResponse.json({ lists: lists.map((l) => ({ id: l.id, name: l.name })) })
  } catch (e) {
    if (tableMissing(e)) return NextResponse.json({ lists: [], unavailable: true })
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
  const body = (await req.json().catch(() => null)) as { company_ids?: unknown; list_id?: unknown; new_list_name?: unknown } | null
  const ids = Array.isArray(body?.company_ids) ? body!.company_ids : null
  if (!ids || ids.length === 0 || ids.length > MAX_IDS || !ids.every((x) => Number.isSafeInteger(x) && (x as number) > 0)) {
    return NextResponse.json({ error: `company_ids must be 1 to ${MAX_IDS} positive integers.` }, { status: 400 })
  }
  const listId = typeof body?.list_id === 'number' && Number.isInteger(body.list_id) && body.list_id > 0 ? body.list_id : null
  const newListName = typeof body?.new_list_name === 'string' ? body.new_list_name : null
  try {
    const r = await addCompaniesToList(db, actor, { listId, newListName }, ids as number[])
    return NextResponse.json({ list: r.list, added: r.added })
  } catch (e) {
    if (e instanceof ListsError) return NextResponse.json({ error: e.message }, { status: 400 })
    if (e instanceof OpsError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
