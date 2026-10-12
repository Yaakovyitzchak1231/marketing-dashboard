/** POST /api/rules/:id/recompute -> queue a full re-score of this rule set, run it in the background. */
import { NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getDb } from '@/lib/db'
import { getRuleSet } from '@/lib/rules/store'
import { queueRecompute } from '@/lib/rules/recompute'
import { kickRecompute } from '@/lib/rules/kick'
import { NO_DB } from '@/lib/rules/http'

export const dynamic = 'force-dynamic'

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Role check first (editor and above); the re-score is queued as the signed-in person.
  let actor: string
  try {
    actor = await actorFor('editor')
  } catch (e) {
    return authDenied(e)
  }
  const db = getDb()
  if (!db) return NextResponse.json({ error: NO_DB }, { status: 503 })
  const { id } = await ctx.params
  const rs = /^\d{1,15}$/.test(id) ? await getRuleSet(db, Number(id)) : null
  if (!rs || rs.archived) return NextResponse.json({ error: 'No rule set with that id.' }, { status: 404 })
  if (rs.scope === 'template') return NextResponse.json({ error: 'A template scores no leads; nothing to re-score.' }, { status: 409 })
  await queueRecompute(db, rs.id, rs.version, actor)
  kickRecompute(db)
  return NextResponse.json({ queued: true, rule_set_id: rs.id, version: rs.version }, { status: 202 })
}
