import 'server-only'
import type { Db } from '@/lib/db/types'

/**
 * The three dashboard roles. Agents (ops-API keys) are a separate world and
 * never carry one of these.
 *
 *   viewer  — read-only.
 *   editor  — viewer, plus editing leads, campaigns, segments.
 *   owner   — editor, plus settings, keys, team, forget/merge.
 */
export type Role = 'viewer' | 'editor' | 'owner'

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 }

export class AuthError extends Error {}

function normalizeEmail(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase()
  return e ? e : null
}

/**
 * The permanent owner fallback. ALLOWED_USER_EMAIL always resolves to
 * 'owner' — with or without a matching lp.actors row, even if the database
 * is unreachable or that row was deleted by mistake. This is what makes
 * "no lockout possible" true: nothing in lp.actors can ever take Yaakov's
 * access away, because his access never depends on a row existing there.
 */
export function isFallbackOwner(email: string | null | undefined): boolean {
  const e = normalizeEmail(email)
  const allowed = normalizeEmail(process.env.ALLOWED_USER_EMAIL)
  return Boolean(e && allowed && e === allowed)
}

/**
 * The signed-in account's role.
 *
 * 1. The env fallback always wins, before any database lookup.
 * 2. Otherwise an active lp.actors human row with a matching email, by its
 *    stored role.
 * 3. Otherwise null — an unknown or deactivated account is denied, never
 *    silently widened.
 *
 * Never throws: a database error denies (fails closed) rather than crashing
 * the request.
 */
export async function resolveRole(email: string | null | undefined, db: Db | null): Promise<Role | null> {
  if (isFallbackOwner(email)) return 'owner'
  const e = normalizeEmail(email)
  if (!e || !db) return null
  try {
    const r = await db.query<{ role: Role | null }>(
      `select role from lp.actors where kind = 'human' and active and email = $1 limit 1`,
      [e],
    )
    return r.rows[0]?.role ?? null
  } catch {
    return null
  }
}

/** Does this role meet or exceed `min` in viewer < editor < owner? */
export function canAtLeast(role: Role | null, min: Role): boolean {
  return role !== null && RANK[role] >= RANK[min]
}

/**
 * Throws AuthError when the current role does not meet `min`. Call at the
 * top of a server action before any write:
 *
 *   const role = await currentRole()
 *   requireRole(role, 'editor')
 */
export function requireRole(role: Role | null, min: Role): void {
  if (!canAtLeast(role, min)) {
    throw new AuthError(role ? `This needs ${min} access; you have ${role} access.` : 'Not signed in.')
  }
}
