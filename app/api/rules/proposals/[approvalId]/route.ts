/** POST /api/rules/proposals/:approvalId {decision: 'apply'|'reject', note?} -- a person decides an agent's rule proposal. */
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { applyProposal, rejectProposal } from '@/lib/rules/store'
import { kickRecompute } from '@/lib/rules/kick'
import { NO_DB, rulesFail } from '@/lib/rules/http'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: Promise<{ approvalId: string }> }) {
  const db = getDb()
  if (!db) return NextResponse.json({ error: NO_DB }, { status: 503 })
  const { approvalId } = await ctx.params
  if (!/^\d{1,15}$/.test(approvalId)) return NextResponse.json({ error: 'No rule proposal with that id.' }, { status: 404 })
  const body = ((await req.json().catch(() => null)) ?? {}) as { decision?: string; note?: string }
  try {
    if (body.decision === 'apply') {
      const out = await applyProposal(db, 'owner', Number(approvalId))
      kickRecompute(db)
      return NextResponse.json({ applied: true, rule_set: out.ruleSet, changes: out.changes })
    }
    if (body.decision === 'reject') {
      await rejectProposal(db, 'owner', Number(approvalId), typeof body.note === 'string' ? body.note.slice(0, 500) : null)
      return NextResponse.json({ rejected: true })
    }
    return NextResponse.json({ error: "decision must be 'apply' or 'reject'." }, { status: 400 })
  } catch (e) {
    return rulesFail(e)
  }
}
