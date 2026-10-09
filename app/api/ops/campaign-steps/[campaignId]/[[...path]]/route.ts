/**
 * Campaign email steps for agents (ops bearer token; a paused agent gets 423 from opsGate).
 * Same contract as /api/campaign-steps (lib/campaign-steps/http.ts), acting as the agent.
 * Agents can edit steps and ASK for an Instantly push; linking and approving stay with a person,
 * and nothing here ever calls Instantly.
 */
import { NextResponse } from 'next/server'
import { opsGate } from '@/lib/ops/gate'
import { handleCampaignSteps } from '@/lib/campaign-steps/http'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ campaignId: string; path?: string[] }> }

async function handle(req: Request, ctx: Ctx) {
  const gate = await opsGate(req)
  if (!gate.ok) return gate.response
  if (!gate.db) return NextResponse.json({ ok: false, error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const { campaignId, path } = await ctx.params
  return handleCampaignSteps(req, gate.db, gate.agent, campaignId, path ?? [])
}

export const GET = handle
export const POST = handle
export const PATCH = handle
export const PUT = handle
export const DELETE = handle
