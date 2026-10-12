/**
 * POST /api/verify/preview
 *   { contact_ids?: number[], filter?: { state?, stage?, verification_status?, segment?, q? },
 *     limit?: number (default 200, max 1000), force?: boolean, recheck_days?: number }
 * Runs the FREE precheck now, records it, and creates a run in status 'preview'
 * with the paid-cost estimate. Nothing paid happens here.
 * -> 201 { run }
 */
import { NextResponse } from 'next/server'
import { createPreview, verifyEnvFromConfig } from '@/lib/verify/runs'
import type { LeadFilter } from '@/lib/verify/select'
import { actorFor } from '@/lib/auth/act'
import { dbOrNull, fail, notConnected, NO_STORE, readJson } from '../_shared'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: Request) {
  const db = dbOrNull()
  if (!db) return notConnected()
  const body = await readJson(req)
  const ids = Array.isArray(body.contact_ids) ? body.contact_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : null
  if (Array.isArray(body.contact_ids) && ids && ids.length === 0) {
    return NextResponse.json({ error: 'contact_ids had no valid ids' }, { status: 400, headers: NO_STORE })
  }
  const filter = body.filter && typeof body.filter === 'object' ? (body.filter as LeadFilter) : null
  const limit = body.limit == null ? null : Number(body.limit)
  if (limit != null && (!Number.isFinite(limit) || limit < 1)) {
    return NextResponse.json({ error: 'limit must be a positive number' }, { status: 400, headers: NO_STORE })
  }
  const recheck = body.recheck_days == null ? undefined : Number(body.recheck_days)
  try {
    const actor = await actorFor('owner')
    const run = await createPreview(
      db,
      {
        contact_ids: ids,
        filter,
        limit,
        force: body.force === true,
        recheck_days: recheck != null && Number.isFinite(recheck) ? recheck : undefined,
        actor,
      },
      await verifyEnvFromConfig(),
    )
    return NextResponse.json({ run }, { status: 201, headers: NO_STORE })
  } catch (e) {
    return fail(e)
  }
}
