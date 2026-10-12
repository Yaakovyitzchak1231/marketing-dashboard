/** GET / PUT / DELETE /api/rules/:id  (see app/api/rules/route.ts for the contract). */
import { NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getDb } from '@/lib/db'
import { archiveRuleSet, getRuleSet, listProposals, saveRuleSet } from '@/lib/rules/store'
import { recomputeStatus, tierCounts, topParkReasons } from '@/lib/rules/recompute'
import { kickRecompute } from '@/lib/rules/kick'
import { NO_DB, rulesFail } from '@/lib/rules/http'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }
const notFound = () => NextResponse.json({ error: 'No rule set with that id.' }, { status: 404 })

async function idOf(ctx: Ctx): Promise<number | null> {
  const { id } = await ctx.params
  return /^\d{1,15}$/.test(id) ? Number(id) : null
}

export async function GET(_req: Request, ctx: Ctx) {
  const db = getDb()
  if (!db) return NextResponse.json({ error: NO_DB }, { status: 503 })
  const id = await idOf(ctx)
  if (!id) return notFound()
  const rs = await getRuleSet(db, id)
  if (!rs) return notFound()
  const [counts, jobs, proposals, reasons] = await Promise.all([tierCounts(db), recomputeStatus(db), listProposals(db, id), topParkReasons(db, id)])
  return NextResponse.json({ rule_set: rs, counts: counts.get(id) ?? null, rescore: jobs.get(id) ?? null, proposals, top_reasons: reasons })
}

export async function PUT(req: Request, ctx: Ctx) {
  // Role check first (editor and above); the change is logged as the signed-in person.
  let actor: string
  try {
    actor = await actorFor('editor')
  } catch (e) {
    return authDenied(e)
  }
  const db = getDb()
  if (!db) return NextResponse.json({ error: NO_DB }, { status: 503 })
  const id = await idOf(ctx)
  if (!id) return notFound()
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const out = await saveRuleSet(db, actor, id, body, { base_version: body?.base_version == null ? null : Number(body.base_version) })
    if (out.changes.length) kickRecompute(db)
    return NextResponse.json({ rule_set: out.ruleSet, changes: out.changes })
  } catch (e) {
    return rulesFail(e)
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  // Role check first (editor and above); the change is logged as the signed-in person.
  let actor: string
  try {
    actor = await actorFor('editor')
  } catch (e) {
    return authDenied(e)
  }
  const db = getDb()
  if (!db) return NextResponse.json({ error: NO_DB }, { status: 503 })
  const id = await idOf(ctx)
  if (!id) return notFound()
  try {
    return NextResponse.json({ rule_set: await archiveRuleSet(db, actor, id) })
  } catch (e) {
    return rulesFail(e)
  }
}
