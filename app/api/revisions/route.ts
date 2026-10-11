import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'
import { auditStamp, recordRevision, readRevisionNumber, sessionEmail, type ArtifactType } from '@/lib/revisions'
import { EDITABLE_ARTIFACTS } from '@/lib/revisions'

const ARTIFACT_TYPES = EDITABLE_ARTIFACTS

export async function GET(_req: NextRequest) {
  const supabase = await getRequestClient(_req)
  if (!supabase) return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  const { searchParams } = new URL(_req.url)
  const artifactType = searchParams.get('artifact_type') ?? ''
  const artifactId = searchParams.get('artifact_id') ?? ''
  if (!ARTIFACT_TYPES.includes(artifactType as ArtifactType)) {
    return NextResponse.json({ error: 'artifact_type must be one of ideas, costs, angles' }, { status: 400 })
  }
  if (!artifactId) {
    return NextResponse.json({ error: 'artifact_id is required' }, { status: 400 })
  }
  const { data, error } = await supabase
    .from('revisions')
    .select('*')
    .eq('artifact_type', artifactType)
    .eq('artifact_id', artifactId)
    .order('revision_number', { ascending: true })
  if (error) {
    console.error(`revisions GET: ${error.message}`)
    return NextResponse.json({ error: 'Failed to fetch revisions' }, { status: 500 })
  }
  return NextResponse.json(data ?? [])
}

export async function POST(req: NextRequest) {
  const supabase = await getRequestClient(req)
  if (!supabase) return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const { artifact_type, artifact_id, revision_number } = body as {
    artifact_type?: unknown
    artifact_id?: unknown
    revision_number?: unknown
  }
  if (!artifact_type || !artifact_id || typeof revision_number !== 'number') {
    return NextResponse.json({ error: 'artifact_type, artifact_id, revision_number required' }, { status: 400 })
  }
  const t = artifact_type as ArtifactType
  if (!ARTIFACT_TYPES.includes(t)) {
    return NextResponse.json({ error: 'artifact_type must be one of ideas, costs, angles' }, { status: 400 })
  }
  const current = await readRevisionNumber(supabase, t, artifact_id as string)
  const expected = typeof current === 'number' ? current + 1 : 1
  if (revision_number !== expected) {
    return NextResponse.json(
      { error: `wrong revision: expected ${expected}, got ${revision_number}` },
      { status: 409 },
    )
  }
  const stamp = await auditStamp(supabase, { headers: req.headers }, {
    artifactType: t,
    artifactId: artifact_id as string,
    changeKind: 'update',
    changeMessage: null,
  })
  const recorded = await recordRevision(supabase, {
    revision_id: stamp.revision_id,
    artifact_type: t,
    artifact_id: artifact_id as string,
    revision_number: stamp.revision_number,
    actor: stamp.actor,
    change_kind: stamp.change_kind,
    change_message: stamp.change_message,
  })
  if ('error' in recorded) {
    console.error(`revisions restore: ${recorded.error}`)
    return NextResponse.json({ error: 'Failed to record revision' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
