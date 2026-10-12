/**
 * GET   /api/campaigns/:id/profile  -> approved profile (lib/campaigns/profile.ts)
 * PATCH /api/campaigns/:id/profile  -> update profile scalars (editor+)
 * Behind the login gate (middleware.ts).
 */
import { NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { AuthError } from '@/lib/auth/roles'
import { getDb } from '@/lib/db'
import { handleCampaignProfile } from '@/lib/campaigns/profile-http'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

function noDb() {
  return NextResponse.json({ ok: false, error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
}

export async function GET(req: Request, ctx: Ctx) {
  try {
    // Any signed-in role may read; the check comes first and names the real person.
    const actor = await actorFor('viewer')
    const db = getDb()
    if (!db) return noDb()
    const { id } = await ctx.params
    return handleCampaignProfile(req, db, actor, id)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ ok: false, error: e.message }, { status: 403 })
    throw e
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const actor = await actorFor('editor')
    const db = getDb()
    if (!db) return noDb()
    const { id } = await ctx.params
    return handleCampaignProfile(req, db, actor, id)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ ok: false, error: e.message }, { status: 403 })
    throw e
  }
}
