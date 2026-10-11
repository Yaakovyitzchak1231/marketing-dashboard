import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import type { Db } from '@/lib/db/types'
import { agentForToken, secretMatches } from './auth'
import { agentForDbKey } from '../notify/keys'
import { pauseBlockFor, pauseMessage } from './pause'

/**
 * The one door every /api/ops/* route goes through.
 *
 *  1. Who is calling: an agent bearer token (OPS_AGENT_TOKENS, or a key minted on
 *     /agents and kept hashed in lp.agent_keys), or, only where a
 *     route allows it, Vercel Cron's CRON_SECRET (acts as 'system').
 *  2. Is that agent paused (or are all agents paused)? Then 423, nothing runs.
 *
 * A route never calls agentForToken itself (tests/agent-pause.test.ts checks
 * every route file), so a paused agent is refused on every ops route, old or new.
 * If the pause state cannot be read, the request is refused (fail closed).
 * With no database configured nothing can have been paused, so the check is skipped.
 */
export type OpsGate =
  | { ok: true; agent: string; db: Db | null }
  | { ok: false; response: NextResponse }

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function opsGate(req: Request, opts: { allowCron?: boolean; cronOnly?: boolean; unauthorizedMessage?: string } = {}): Promise<OpsGate> {
  const authorization = req.headers.get('authorization')
  // Scheduler-only routes must not accept agent credentials, even a token mapped to 'system'.
  let agent = opts.cronOnly ? null : agentForToken(authorization)
  // Only keys minted on /agents (mdk_…) are looked up in the database; anything else never costs a query.
  if (!opts.cronOnly && !agent && authorization && /^Bearer\s+mdk_/i.test(authorization.trim())) {
    const kdb = getDb()
    if (kdb) {
      try {
        agent = await agentForDbKey(kdb, authorization)
      } catch {
        agent = null // before migration 0013 runs there is no key table; env tokens still work
      }
    }
  }
  if (!agent && (opts.allowCron || opts.cronOnly)) {
    const m = /^Bearer\s+(.+)$/i.exec(authorization ?? '')
    if (m && secretMatches(m[1].trim(), process.env.CRON_SECRET)) agent = 'system'
  }
  if (!agent) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: opts.unauthorizedMessage ?? 'Missing or unknown agent token (Authorization: Bearer <token>).' },
        { status: 401, headers: NO_STORE },
      ),
    }
  }
  const db = getDb()
  if (db) {
    try {
      const block = await pauseBlockFor(db, agent)
      if (block) {
        return {
          ok: false,
          response: NextResponse.json(
            {
              ok: false,
              error: pauseMessage(agent, block),
              paused: { scope: block.scope, by: block.by, by_name: block.by_name, at: block.at.toISOString(), reason: block.reason },
            },
            { status: 423, headers: NO_STORE },
          ),
        }
      }
    } catch (e) {
      return {
        ok: false,
        response: NextResponse.json(
          { ok: false, error: `Could not check whether ${agent} is paused, so nothing was done: ${(e as Error).message}` },
          { status: 503, headers: NO_STORE },
        ),
      }
    }
  }
  return { ok: true, agent, db }
}
