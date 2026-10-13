/**
 * The OAuth `state` round trip for Connect Outlook: a random value set in a
 * short-lived httpOnly cookie on /connect and compared (constant time) on
 * /callback, so a callback the owner did not start is refused. The cookie also
 * carries where to send the owner back to (a same-site path only).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const STATE_COOKIE = 'mbx_outlook_oauth'
export const STATE_COOKIE_PATH = '/api/mailbox/outlook'
export const STATE_MAX_AGE_SEC = 600

export function newState(): string {
  return randomBytes(24).toString('base64url')
}

export function encodeStateCookie(state: string, next: string): string {
  return Buffer.from(JSON.stringify({ s: state, n: next }), 'utf8').toString('base64url')
}

export function decodeStateCookie(raw: string | undefined | null): { state: string; next: string } | null {
  if (!raw) return null
  try {
    const j = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { s?: unknown; n?: unknown }
    if (typeof j.s !== 'string' || typeof j.n !== 'string') return null
    return { state: j.s, next: j.n }
  } catch {
    return null
  }
}

export function stateMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false
  const a = new Uint8Array(Buffer.from(expected))
  const b = new Uint8Array(Buffer.from(given))
  return a.length === b.length && timingSafeEqual(a, b)
}
