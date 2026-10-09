/**
 * The ops API: how agents (Tab, Hermes, Claude, Manus...) work in the same
 * database as the humans. Authenticated by each agent's own bearer token
 * (OPS_AGENT_TOKENS); the login gate in middleware.ts lets /api/ops through so
 * this route can do that check itself (lib/ops/gate.ts: token, then
 * "is this agent paused?" -> 423).
 *
 *   GET  /api/ops                       -> the list of ops and their arguments
 *   POST /api/ops  {op, ...args}        -> run one op as the calling agent
 *   REST aliases: POST /api/ops/tasks/claim, POST /api/ops/tasks/:id/heartbeat|complete|fail|handoff|comment,
 *   POST /api/ops/locks/acquire|release, POST /api/ops/events, POST /api/ops/approvals, GET /api/ops/approvals/:id,
 *   GET|POST /api/ops/memory, GET /api/ops/memory/:key, GET /api/ops/inbox, POST /api/ops/inbox/read, POST /api/ops/presence
 */
import { NextRequest, NextResponse } from 'next/server'
import { opsGate } from '@/lib/ops/gate'
import { OPS, routeToOp, runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ path?: string[] }> }

const NO_STORE = { 'Cache-Control': 'no-store' }

function fail(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE })
}

async function handle(req: NextRequest, ctx: Ctx, method: 'GET' | 'POST') {
  const gate = await opsGate(req)
  if (!gate.ok) return gate.response
  const { agent, db } = gate
  if (!db) return fail(503, 'The lead database is not connected (DATABASE_URL is not set).')

  const path = (await ctx.params).path ?? []
  let op: string
  let args: Record<string, unknown> = {}

  if (path.length === 0) {
    if (method === 'GET') {
      return NextResponse.json(
        { ok: true, agent, ops: Object.fromEntries(Object.entries(OPS).map(([k, v]) => [k, v.args])) },
        { headers: NO_STORE },
      )
    }
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || typeof (body as { op?: unknown }).op !== 'string') return fail(400, 'Body must be JSON: {"op": "...", ...args}')
    const { op: o, ...rest } = body as Record<string, unknown>
    op = String(o)
    args = rest
  } else {
    const r = routeToOp(method, path)
    if (!r) return fail(404, `No ops route for ${method} /api/ops/${path.join('/')}. GET /api/ops lists the ops.`)
    op = r.op
    const extra: Record<string, unknown> = {}
    if (method === 'POST') {
      const body = await req.json().catch(() => ({}))
      if (body && typeof body === 'object') Object.assign(extra, body)
    } else {
      req.nextUrl.searchParams.forEach((v, k) => {
        extra[k] = k === 'status' || k === 'kinds' ? v.split(',') : v
      })
    }
    args = { ...extra, ...r.args }
  }

  try {
    const data = await runOp(db, agent, op, args)
    return NextResponse.json({ ok: true, op, data }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof OpsError) return fail(e.status, e.message)
    console.error('ops error', op, (e as Error).message)
    return fail(500, 'The operation failed on the server.')
  }
}

export function GET(req: NextRequest, ctx: Ctx) {
  return handle(req, ctx, 'GET')
}

export function POST(req: NextRequest, ctx: Ctx) {
  return handle(req, ctx, 'POST')
}
