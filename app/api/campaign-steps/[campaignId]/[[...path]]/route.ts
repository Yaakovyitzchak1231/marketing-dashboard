/**
 * Campaign email steps, preview and Instantly link, for the signed-in person (actor 'owner').
 * Behind the login gate (middleware.ts). Contract: lib/campaign-steps/http.ts.
 */
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { handleCampaignSteps } from '@/lib/campaign-steps/http'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ campaignId: string; path?: string[] }> }

async function handle(req: Request, ctx: Ctx) {
  const db = getDb()
  if (!db) return NextResponse.json({ ok: false, error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const { campaignId, path } = await ctx.params
  return handleCampaignSteps(req, db, 'owner', campaignId, path ?? [])
}

export const GET = handle
export const POST = handle
export const PATCH = handle
export const PUT = handle
export const DELETE = handle
