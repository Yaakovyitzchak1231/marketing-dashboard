import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'
import { EDITABLE_ARTIFACTS, sessionEmail, requestJwt } from '@/lib/revisions'

const ARTIFACT_TYPES = EDITABLE_ARTIFACTS

export async function GET(req: NextRequest) {
  const supabase = await getRequestClient(req)
  if (!supabase) return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  const url = new URL(req.url)
  const artifactType = url.searchParams.get('artifact_type') ?? ''
  const artifactId = url.searchParams.get('artifact_id') ?? ''
  if (!ARTIFACT_TYPES.includes(artifactType as typeof ARTIFACT_TYPES[number])) {
    return NextResponse.json(
      { error: 'artifact_type must be ideas, costs, or angles' },
      { status: 400 },
    )
  }
  if (!artifactId) {
    return NextResponse.json({ error: 'artifact_id is required' }, { status: 400 })
  }
  const { data, error } = await supabase
    .from('checkpoints')
    .select('*')
    .eq('artifact_type', artifactType)
    .eq('artifact_id', artifactId)
    .order('created_at', { ascending: false })
  if (error) {
    console.error(`checkpoints GET: ${error.message}`)
    return NextResponse.json({ error: 'Failed to fetch checkpoints' }, { status: 500 })
  }
  return NextResponse.json((data ?? []) as Array<Record<string, unknown>>)
}

/**
 * Checkpoints POST: pin the current version of an artifact.
 * Writes ride RLS as the signed-in user — actor is the session email, or
 * NULL when the source did not say. Never a client-supplied email.
 */
export async function POST(req: NextRequest) {
  const supabase = await getRequestClient(req)
  if (!supabase) return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const { artifact_type, artifact_id, revision_number, name, snapshot } = body as {
    artifact_type?: unknown
    artifact_id?: unknown
    revision_number?: unknown
    name?: unknown
    snapshot?: unknown
  }
  if (!artifact_type || !artifact_id) {
    return NextResponse.json(
      { error: 'artifact_type, artifact_id required' },
      { status: 400 },
    )
  }
  const t = artifact_type as (typeof ARTIFACT_TYPES)[number]
  if (!ARTIFACT_TYPES.includes(t)) {
    return NextResponse.json(
      { error: 'artifact_type must be ideas, costs, or angles' },
      { status: 400 },
    )
  }
  // name is NOT NULL on the live table (pre-collab shape), so a pin always
  // carries a label — the caller's or a default. Never an empty slot.
  const label =
    typeof name === 'string' && name.trim()
      ? name.trim()
      : `Pin revision ${typeof revision_number === 'number' ? revision_number : 'current'}`
  const { data, error } = await supabase
    .from('checkpoints')
    .insert({
      artifact_type: t,
      artifact_id: artifact_id as string,
      revision_number:
        typeof revision_number === 'number' ? revision_number : null,
      name: label,
      snapshot:
        snapshot !== undefined && snapshot !== null
          ? (snapshot as Record<string, unknown>)
          : null,
      actor: await sessionEmail(supabase, requestJwt(req)),
    })
    .select()
    .single()
  if (error) {
    console.error(`checkpoints POST: ${error.message}`)
    return NextResponse.json({ error: 'Failed to pin checkpoint' }, { status: 500 })
  }
  return NextResponse.json(data, { status: 201 })
}
