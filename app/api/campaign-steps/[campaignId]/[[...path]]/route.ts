/**
 * Campaign email steps, preview and Instantly link, for the signed-in person.
 * Behind the login gate (middleware.ts). Editor or above; the audit log names
 * the real actor (not a hard-coded 'owner'). Contract: lib/campaign-steps/http.ts.
 */
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { actorFor } from '@/lib/auth/act'
import { AuthError } from '@/lib/auth/roles'
import { handleCampaignSteps } from '@/lib/campaign-steps/http'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ campaignId: string; path?: string[] }> }

async function handle(req: Request, ctx: Ctx) {
  const db = getDb()
  if (!db) return NextResponse.json({ ok: false, error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  let actor: string
  try {
    actor = await actorFor('editor')
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ ok: false, error: 'Editor access or above is required.' }, { status: 403 })
    throw e
  }
  const { campaignId, path } = await ctx.params
  return handleCampaignSteps(req, db, actor, campaignId, path ?? [], 'human')
}

export const GET = handle
export const POST = handle
export const PATCH = handle
export const PUT = handle
export const DELETE = handle
