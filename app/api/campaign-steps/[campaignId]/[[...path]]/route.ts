/**
 * Campaign email steps, preview and Instantly link, for the signed-in person (reads: any role; writes: editor or owner, logged under their own actor id).
 * Behind the login gate (middleware.ts). Contract: lib/campaign-steps/http.ts.
 */
import { NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getDb } from '@/lib/db'
import { handleCampaignSteps } from '@/lib/campaign-steps/http'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ campaignId: string; path?: string[] }> }

async function handle(req: Request, ctx: Ctx) {
  // Role check first. Reads need any signed-in role; every other method needs
  // editor or owner, and is logged as the signed-in person.
  const read = req.method === 'GET' || req.method === 'HEAD'
  let actor: string
  try {
    actor = await actorFor(read ? 'viewer' : 'editor')
  } catch (e) {
    return authDenied(e, { ok: false })
  }
  const db = getDb()
  if (!db) return NextResponse.json({ ok: false, error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const { campaignId, path } = await ctx.params
  return handleCampaignSteps(req, db, actor, campaignId, path ?? [])
}

export const GET = handle
export const POST = handle
export const PATCH = handle
export const PUT = handle
export const DELETE = handle
