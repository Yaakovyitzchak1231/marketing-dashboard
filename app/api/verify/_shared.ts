import { NextResponse } from 'next/server'
import { getDb, type Db } from '@/lib/db'
import { RunError } from '@/lib/verify/runs'
import { AuthError } from '@/lib/auth/roles'

export const NO_STORE = { 'Cache-Control': 'private, no-store' }

export function notConnected() {
  return NextResponse.json({ error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503, headers: NO_STORE })
}

export function dbOrNull(): Db | null {
  return getDb()
}

export function parseRunId(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function fail(e: unknown) {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
  if (e instanceof RunError) return NextResponse.json({ error: e.message }, { status: e.status, headers: NO_STORE })
  // Never echo internals (or anything that might carry a key) to the browser.
  console.error('verify route failed:', e instanceof Error ? e.name : 'error')
  return NextResponse.json({ error: 'Verification request failed on the server.' }, { status: 500, headers: NO_STORE })
}
