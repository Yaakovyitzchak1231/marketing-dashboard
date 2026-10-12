/**
 * POST /api/leads/:id/owner-research  {exhausted: true|false, note?}
 *   -> 200 {changed, exhausted}
 * Human route (editor or owner; actor = the signed-in person). Agents use the ops op
 * mark_owner_research_exhausted. Marking it releases the store's role inbox
 * (role-based-hold) to Ready-generic, role-inbox batches only. Logged.
 */
import { NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getDb } from '@/lib/db'
import { setOwnerResearchExhausted } from '@/lib/rules/owner-research'
import { NO_DB, rulesFail } from '@/lib/rules/http'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Role check first (editor and above); the change is logged as the signed-in person.
  let actor: string
  try {
    actor = await actorFor('editor')
  } catch (e) {
    return authDenied(e)
  }
  const db = getDb()
  if (!db) return NextResponse.json({ error: NO_DB }, { status: 503 })
  const { id } = await ctx.params
  if (!/^\d{1,15}$/.test(id)) return NextResponse.json({ error: 'No lead with that id.' }, { status: 404 })
  const body = ((await req.json().catch(() => null)) ?? {}) as { exhausted?: unknown; note?: unknown }
  if (typeof body.exhausted !== 'boolean') return NextResponse.json({ error: 'exhausted must be true or false.' }, { status: 400 })
  try {
    return NextResponse.json(await setOwnerResearchExhausted(db, actor, Number(id), body.exhausted, typeof body.note === 'string' ? body.note : null))
  } catch (e) {
    return rulesFail(e)
  }
}
