import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'
import { auditStamp, changeMessageFrom, recordRevision } from '@/lib/revisions'

const UPDATABLE = ['name', 'description', 'campaign_id', 'variant_label'] as const

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  const { id } = await params
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const patch: Record<string, unknown> = {}
  for (const key of UPDATABLE) {
    if (key in body) patch[key] = body[key]
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }
  const stamp = await auditStamp(supabase, request, {
    artifactType: 'angles',
    artifactId: id,
    changeKind: 'update',
    changeMessage: changeMessageFrom(body),
  })
  const { data, error } = await supabase
    .from('angles')
    .update({ ...patch, ...stamp })
    .eq('id', id)
    .select()
    .single()
  if (error) {
    return NextResponse.json({ error: 'Failed to update angle' }, { status: 500 })
  }
  const recorded = await recordRevision(supabase, {
    revision_id: stamp.revision_id,
    artifact_type: 'angles',
    artifact_id: id,
    revision_number: stamp.revision_number,
    actor: stamp.actor,
    change_kind: stamp.change_kind,
    change_message: stamp.change_message,
  })
  if ('error' in recorded) {
    console.error(`angles PATCH revision: ${recorded.error}`)
    return NextResponse.json({ error: 'Failed to record revision' }, { status: 500 })
  }
  return NextResponse.json(data)
}

export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  return PATCH(request, ctx)
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  const { id } = await params
  const stamp = await auditStamp(supabase, request, {
    artifactType: 'angles',
    artifactId: id,
    changeKind: 'delete',
    changeMessage: null,
  })
  // See the matching comment in ideas/[id]: no DELETE policy exists on angles,
  // so RLS hides the row, the delete matches nothing, and `error` stays null.
  const { data, error } = await supabase.from('angles').delete().eq('id', id).select('id')
  if (error) {
    console.error(`angles DELETE: query failed (${error.code}): ${error.message}`)
    return NextResponse.json({ error: 'Failed to delete angle' }, { status: 500 })
  }
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: 'Angle not found, or not deletable by this user' },
      { status: 404 },
    )
  }
  const recorded = await recordRevision(supabase, {
    revision_id: stamp.revision_id,
    artifact_type: 'angles',
    artifact_id: id,
    revision_number: stamp.revision_number,
    actor: stamp.actor,
    change_kind: 'delete',
    change_message: null,
  })
  if ('error' in recorded) {
    console.error(`angles DELETE revision: ${recorded.error}`)
    return NextResponse.json({ error: 'Failed to record revision' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
