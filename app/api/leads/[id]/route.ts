/**
 * PATCH /api/leads/:id  {name?, website?, phone?, city?, state?}
 *   -> 200 {company, changes}
 *   -> 400 {error} bad value · 404 {error} no such lead · 409 {error} another lead
 *      already has that website/phone/name+address · 503 {error} no DATABASE_URL
 * Human route (editor or owner); the actor is the signed-in person. Only fields that
 * changed are written; each change is in the lead's history and the activity log.
 */
import { NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getDb } from '@/lib/db'
import { COMPANY_EDIT_FIELDS, editCompany, LeadEditError, parsePatch } from '@/lib/leads/edit'

export const dynamic = 'force-dynamic'

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Role check first (editor and above); the edit is logged as the signed-in person.
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
  try {
    const patch = parsePatch(await req.json().catch(() => null), COMPANY_EDIT_FIELDS)
    const r = await editCompany(db, Number(id), patch, actor)
    return NextResponse.json({ company: r.company, changes: r.changes })
  } catch (e) {
    if (e instanceof LeadEditError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
