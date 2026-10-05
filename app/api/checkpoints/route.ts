import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'
import { saveCheckpoint } from '@/lib/revisions'

/**
 * POST /api/checkpoints
 *
 * Save a named checkpoint of the current heads (per-object latest revision).
 * A missing or empty name uses a timestamp. Save and Pin are distinct: this
 * route only saves; pinning is POST /api/checkpoints/[id]/pin.
 */
export async function POST(request: NextRequest) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  const name = typeof body.name === 'string' ? body.name : null
  const result = await saveCheckpoint(supabase, request, { name })

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json(result.checkpoint, { status: 201 })
}
