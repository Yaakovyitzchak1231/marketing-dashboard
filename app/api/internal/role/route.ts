import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getDb } from '@/lib/db'
import { getRequestClient } from '@/lib/request-client'
import { resolveRole } from '@/lib/auth/roles'

/**
 * Internal only: resolves the CALLING REQUEST's own Supabase session to a
 * dashboard role (lib/auth/roles.ts). Middleware (middleware.ts) calls this
 * because it runs on the Edge runtime and cannot open a plain Postgres
 * connection (lib/db uses `pg`, which needs Node's net/tls) -- this route
 * runs on the normal Node.js runtime, same as every page, and can.
 *
 * Self-authenticating, like /api/ops and /api/webhooks (middleware.ts exempts
 * it from the login gate for that reason): it does NOT trust an email from
 * the caller, it re-derives the session from this request's own cookies
 * (the same ones middleware already validated) and answers only for that
 * session. No session -> { role: null }, same shape as any other failure, so
 * a probe with no cookie never learns whether any particular email exists.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await getRequestClient(request)
    if (!supabase) return NextResponse.json({ role: null })
    const { data, error } = await supabase.auth.getUser()
    if (error || !data.user?.email) return NextResponse.json({ role: null })
    const role = await resolveRole(data.user.email, getDb())
    return NextResponse.json({ role })
  } catch {
    return NextResponse.json({ role: null })
  }
}
