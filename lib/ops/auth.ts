import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Agent authentication for the ops API.
 *
 * OPS_AGENT_TOKENS = "tab:<token>,hermes:<token>,claude:<token>"
 * Each agent gets its own long random token (24+ chars); the id before the
 * colon must be an actor in lp.actors. A request carries
 * `Authorization: Bearer <token>` and acts as that agent -- an agent can
 * never act as another agent or as a human.
 */
function digest(s: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(s, 'utf8').digest())
}

export function parseAgentTokens(raw: string | undefined): { id: string; token: string }[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(':')
      return i > 0 ? { id: pair.slice(0, i).trim().toLowerCase(), token: pair.slice(i + 1).trim() } : null
    })
    .filter((x): x is { id: string; token: string } => Boolean(x && x.id && x.token.length >= 24))
}

/** The agent id a bearer token belongs to, or null. Constant-time comparison. */
export function agentForToken(authorization: string | null, raw = process.env.OPS_AGENT_TOKENS): string | null {
  if (!authorization) return null
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  if (!m) return null
  const given = digest(m[1].trim())
  let found: string | null = null
  for (const { id, token } of parseAgentTokens(raw)) {
    if (timingSafeEqual(given, digest(token))) found = id
  }
  return found
}

/** Shared-secret check for inbound webhooks (constant time; unset secret = reject). */
export function secretMatches(given: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || expected.length < 16 || !given) return false
  return timingSafeEqual(digest(given), digest(expected))
}
