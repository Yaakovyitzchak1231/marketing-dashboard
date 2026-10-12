/**
 * POST /api/leads/:id/comments  {body: string}
 *   -> 201 {comment: {id, mentions}}
 *   -> 400 {error} empty/too long · 404 {error} no such lead · 503 {error} no DATABASE_URL
 * Human route (editor or owner); the author is the signed-in person. Goes through
 * the shared ops layer (lib/ops/core.ts comment()), which resolves @mentions to
 * actors, writes lp.notifications for each, and logs the activity event.
 */
import { NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getDb } from '@/lib/db'
import { comment, OpsError } from '@/lib/ops/core'
import { kickDelivery } from '@/lib/notify/kick'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Role check first (editor and above); the comment is authored by the signed-in person.
  let actor: string
  try {
    actor = await actorFor('editor')
  } catch (e) {
    return authDenied(e)
  }
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const { id } = await ctx.params
  if (!/^\d{1,15}$/.test(id)) return NextResponse.json({ error: 'No lead with that id.' }, { status: 404 })
  const json = (await req.json().catch(() => null)) as { body?: unknown } | null
  if (typeof json?.body !== 'string' || !json.body.trim()) return NextResponse.json({ error: 'Write something first.' }, { status: 400 })
  const exists = await db.query<{ id: number }>('select id from lp.companies where id = $1', [Number(id)])
  if (!exists.rows[0]) return NextResponse.json({ error: 'No lead with that id.' }, { status: 404 })
  try {
    const c = await comment(db, actor, { company_id: Number(id), body: json.body })
    kickDelivery(db)
    return NextResponse.json({ comment: c }, { status: 201 })
  } catch (e) {
    if (e instanceof OpsError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
