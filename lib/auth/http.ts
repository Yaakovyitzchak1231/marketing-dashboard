import { NextResponse } from 'next/server'
import { AuthError } from './roles'

/**
 * The 403 for an API route whose `actorFor(min)` call threw. Anything that is
 * not an AuthError is rethrown untouched, so a real failure is never reported
 * as "not allowed".
 *
 *   let actor: string
 *   try { actor = await actorFor('editor') } catch (e) { return authDenied(e) }
 *
 * Call it as the FIRST thing in a handler, before the database, the body or
 * any validation, so a caller without the role learns nothing from the
 * response. `extra` adds fields some routes' contracts carry (`{ ok: false }`).
 */
export function authDenied(e: unknown, extra: Record<string, unknown> = {}): NextResponse {
  if (e instanceof AuthError) {
    return NextResponse.json({ ...extra, error: e.message }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } })
  }
  throw e
}
