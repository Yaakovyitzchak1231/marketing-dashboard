/**
 * MCP server (Streamable HTTP, stateless): POST JSON-RPC, answered with JSON.
 * Auth: Authorization: Bearer <agent key>, through opsGate like every ops route
 * (a paused agent gets 423). Tools: lib/notify/mcp.ts.
 */
import { NextRequest, NextResponse } from 'next/server'
import { opsGate } from '@/lib/ops/gate'
import { handleMcp } from '@/lib/notify/mcp'
import { kickDelivery } from '@/lib/notify/kick'

export const dynamic = 'force-dynamic'
// Same budget as /api/ops: an agent's long op (recompute_scores, recompute_traits) over MCP
// must not be cut off at the default function time (review fix, Hermes).
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const gate = await opsGate(req)
  if (!gate.ok) return gate.response
  const { agent, db } = gate
  const body = await req.json().catch(() => undefined)
  if (body === undefined) return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, { status: 400 })
  if (!db) return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'The lead database is not connected.' } }, { status: 503 })
  const batch = Array.isArray(body) ? body : [body]
  const out = []
  for (const m of batch) {
    const r = await handleMcp(db, agent, m ?? {})
    if (r) out.push(r)
  }
  kickDelivery(db)
  if (!out.length) return new NextResponse(null, { status: 202 })
  return NextResponse.json(Array.isArray(body) ? out : out[0], { headers: { 'Cache-Control': 'no-store' } })
}

/** No server-initiated stream here; agents that want push use /api/ops/stream or a webhook/ntfy channel. */
export function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } })
}
