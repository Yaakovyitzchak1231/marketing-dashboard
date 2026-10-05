import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'
import { auditStamp, businessSnapshot, changeMessageFrom, recordRevision } from '@/lib/revisions'

/**
 * Ideas: the manual entry point for "what are we trying?".
 * GET lists, POST creates. Writes go through RLS as the signed-in user.
 */

export async function GET(request: NextRequest) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  // The schema's idea label column is `title` (with `hypothesis` as the
  // free-text body) and ideas has no channel_id, so the `channels` join does
  // not exist. Columns are mapped onto the shape the UI consumes rather than
  // renamed in the schema.
  const { data, error } = await supabase
    .from('ideas')
    .select('id, title, hypothesis, status, created_at, updated_at, revision_id, revision_number, change_kind, change_message, actor')
    .order('created_at', { ascending: false })
  if (error) {
    console.error(`ideas: query failed (${error.code}): ${error.message}`)
    return NextResponse.json({ error: 'Failed to fetch ideas' }, { status: 500 })
  }
  const rows = ((data ?? []) as Record<string, unknown>[]).map(idea => ({
    ...idea,
    name: idea.title ?? null,
    description: idea.hypothesis ?? null,
    // ideas carries no channel_id, so the channel is unknown, not "email".
    channels: null,
  }))
  return NextResponse.json(rows)
}

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
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  // Writes map onto the real schema columns: title/hypothesis, with the
  // status CHECK constraint from 002_unified_model.sql. There is no
  // channel_id on ideas, so a requested channel is dropped rather than
  // silently attached to the wrong table.
  const stamp = await auditStamp(supabase, request, {
    artifactType: 'ideas',
    artifactId: null,
    changeKind: 'create',
    changeMessage: changeMessageFrom(body),
  })
  const row = {
    title: name,
    hypothesis: typeof body.description === 'string' ? body.description : null,
    status: typeof body.status === 'string' ? body.status : 'backlog',
    ...stamp,
  }
  const { data, error } = await supabase
    .from('ideas')
    .insert(row)
    .select()
    .single()
  if (error) {
    return NextResponse.json({ error: 'Failed to create idea' }, { status: 500 })
  }
  const createdId = (data as { id?: string } | null)?.id
  if (!createdId) {
    return NextResponse.json({ error: 'Failed to create idea' }, { status: 500 })
  }
  const recorded = await recordRevision(supabase, {
    revision_id: stamp.revision_id,
    artifact_type: 'ideas',
    artifact_id: createdId,
    revision_number: stamp.revision_number,
    actor: stamp.actor,
    change_kind: stamp.change_kind,
    change_message: stamp.change_message,
    snapshot: businessSnapshot('ideas', data as Record<string, unknown> | null),
  })
  if ('error' in recorded) {
    console.error(`ideas POST revision: ${recorded.error}`)
    return NextResponse.json({ error: 'Failed to record revision' }, { status: 500 })
  }
  return NextResponse.json(data, { status: 201 })
}
