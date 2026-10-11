import 'server-only'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { getDb } from '@/lib/db'
import { AuthError, isFallbackOwner, resolveRole, type Role } from './roles'

/**
 * The signed-in user's email, read from the Supabase session cookie that
 * middleware already validated for this request. Read-only: unlike
 * middleware, a server action has no response to write a refreshed cookie
 * onto, so a near-expiry token is left for middleware's own refresh on the
 * next request rather than attempted here.
 */
export async function currentEmail(): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null
  try {
    const store = await cookies()
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return store.getAll()
        },
        setAll() {
          // Read-only here; middleware.ts owns writing refreshed cookies.
        },
      },
    })
    const { data, error } = await supabase.auth.getUser()
    if (error || !data.user) return null
    return data.user.email ?? null
  } catch {
    return null
  }
}

/** The signed-in account's role (see lib/auth/roles.ts), or null if signed out or unknown. */
export async function currentRole(): Promise<Role | null> {
  const email = await currentEmail()
  return resolveRole(email, getDb())
}

/**
 * The lp.actors id to write as `actor` on a db.tx — the same convention every
 * existing server action already uses for the single-owner case ('owner').
 * The env fallback always maps to the literal id 'owner' (the seeded row),
 * regardless of which address ALLOWED_USER_EMAIL actually holds; a
 * DB-registered human maps to their own actor id.
 */
export async function currentActorId(): Promise<string> {
  const email = await currentEmail()
  if (isFallbackOwner(email)) return 'owner'
  const db = getDb()
  if (email && db) {
    try {
      const r = await db.query<{ id: string }>(
        `select id from lp.actors where kind = 'human' and active and email = $1 limit 1`,
        [email.toLowerCase()],
      )
      if (r.rows[0]) return r.rows[0].id
    } catch {
      // fall through: fail closed below
    }
  }
  // Fail closed (Hermes review): never write a change as 'owner' for someone we
  // could not identify. Nothing is saved; the action shows this message.
  throw new AuthError(email ? "Couldn't confirm your account, so nothing was saved. Try again." : 'Not signed in.')
}
