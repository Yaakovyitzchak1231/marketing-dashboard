import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'
import { auditStamp, businessSnapshot, changeMessageFrom, recordRevision } from '@/lib/revisions'

// costs stores cost_date (not spent_at) and links to what the spend served via
// the free-text entity_ref; there is no idea_id or campaign_id column. Listing
// them here would let PATCH answer 200 while writing nothing.
const UPDATABLE = ['amount_usd', 'category', 'entity_ref', 'cost_date', 'notes'] as const

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
  if ('amount_usd' in patch) {
    const amount = Number(patch.amount_usd)
    if (!Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ error: 'amount_usd must be a non-negative number' }, { status: 400 })
    }
    patch.amount_usd = amount
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }
  const stamp = await auditStamp(supabase, request, {
    artifactType: 'costs',
    artifactId: id,
    changeKind: 'update',
    changeMessage: changeMessageFrom(body),
  })
  const { data, error } = await supabase
    .from('costs')
    .update({ ...patch, ...stamp })
    .eq('id', id)
    .select()
    .single()
  if (error) {
    return NextResponse.json({ error: 'Failed to update cost' }, { status: 500 })
  }
  const recorded = await recordRevision(supabase, {
    revision_id: stamp.revision_id,
    artifact_type: 'costs',
    artifact_id: id,
    revision_number: stamp.revision_number,
    actor: stamp.actor,
    change_kind: stamp.change_kind,
    change_message: stamp.change_message,
    snapshot: businessSnapshot('costs', data as Record<string, unknown> | null),
  })
  if ('error' in recorded) {
    console.error(`costs PATCH revision: ${recorded.error}`)
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
    artifactType: 'costs',
    artifactId: id,
    changeKind: 'delete',
    changeMessage: null,
  })
  // See the matching comment in ideas/[id]: no DELETE policy exists on costs,
  // so RLS hides the row, the delete matches nothing, and `error` stays null.
  // The row count is the only honest signal that the delete happened.
  const { data, error } = await supabase.from('costs').delete().eq('id', id).select('id')
  if (error) {
    console.error(`costs DELETE: query failed (${error.code}): ${error.message}`)
    return NextResponse.json({ error: 'Failed to delete cost' }, { status: 500 })
  }
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: 'Cost not found, or not deletable by this user' },
      { status: 404 },
    )
  }
  const recorded = await recordRevision(supabase, {
    revision_id: stamp.revision_id,
    artifact_type: 'costs',
    artifact_id: id,
    revision_number: stamp.revision_number,
    actor: stamp.actor,
    change_kind: 'delete',
    change_message: null,
  })
  if ('error' in recorded) {
    console.error(`costs DELETE revision: ${recorded.error}`)
    return NextResponse.json({ error: 'Failed to record revision' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
