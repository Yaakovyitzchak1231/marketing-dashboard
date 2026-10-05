import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'
import { changeMessageFrom, EDITABLE_ARTIFACTS, restoreRevision } from '@/lib/revisions'
import type { ArtifactType } from '@/lib/revisions'

/**
 * POST /api/revisions/restore
 *
 * Restore a live row to the business columns stored at an earlier revision.
 * The write is stamped with the restoring actor (change_kind 'restore'), never
 * the original author. Authorization: the owner, or an agent that already
 * touched this object. A NULL actor is refused.
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
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const artifactType = body.artifact_type
  const artifactId = body.artifact_id
  const revisionNumber = body.revision_number

  if (
    typeof artifactType !== 'string' ||
    !EDITABLE_ARTIFACTS.includes(artifactType as ArtifactType)
  ) {
    return NextResponse.json(
      { error: 'artifact_type must be one of ideas, costs, angles' },
      { status: 400 },
    )
  }
  if (typeof artifactId !== 'string' || !artifactId) {
    return NextResponse.json({ error: 'artifact_id is required' }, { status: 400 })
  }
  if (typeof revisionNumber !== 'number' || !Number.isInteger(revisionNumber)) {
    return NextResponse.json(
      { error: 'revision_number must be an integer' },
      { status: 400 },
    )
  }

  const result = await restoreRevision(supabase, request, {
    artifactType: artifactType as ArtifactType,
    artifactId,
    revisionNumber,
    changeMessage: changeMessageFrom(body),
  })

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json(result)
}
