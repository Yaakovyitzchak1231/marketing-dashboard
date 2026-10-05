import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'
import { pinCheckpoint } from '@/lib/revisions'

/**
 * POST /api/checkpoints/[id]/pin
 *
 * Pin a checkpoint as the default the workspace opens. Exactly one default is
 * maintained: the prior default is cleared before this one is set.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }

  const { id } = await params
  if (!id) {
    return NextResponse.json({ error: 'Checkpoint id is required' }, { status: 400 })
  }

  const result = await pinCheckpoint(supabase, { id })

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json(result.checkpoint)
}
