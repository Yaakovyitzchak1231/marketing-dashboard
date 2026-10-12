import { NextRequest, NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getRequestClient } from '@/lib/request-client'
import { EDITABLE_ARTIFACTS, sessionEmail } from '@/lib/revisions'

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
    .from('comments')
    .select('*')
    .eq('artifact_type', artifactType)
    .eq('artifact_id', artifactId)
    .order('created_at', { ascending: false })
  if (error) {
    console.error(`comments GET: ${error.message}`)
    return NextResponse.json({ error: 'Failed to fetch comments' }, { status: 500 })
  }
  return NextResponse.json((data ?? []) as Array<Record<string, unknown>>)
}

/**
 * Comments POST: the row-comment form in the provenance panel.
 * Writes ride RLS as the signed-in user — author is the session email, or
 * NULL when the source did not say. Never a client-supplied email.
 */
export async function POST(req: NextRequest) {
  // Editors and owners only (middleware already blocks viewers); the stored actor stays the session email.
  try {
    await actorFor('editor')
  } catch (e) {
    return authDenied(e)
  }
  const supabase = await getRequestClient(req)
  if (!supabase) return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const { artifact_type, artifact_id, row_name, text } = body as {
    artifact_type?: unknown
    artifact_id?: unknown
    row_name?: unknown
    text?: unknown
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
  if (typeof text !== 'string' || !text.trim()) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 })
  }
  const { data, error } = await supabase
    .from('comments')
    .insert({
      artifact_type: t,
      artifact_id: artifact_id as string,
      row_name: typeof row_name === 'string' ? row_name : '',
      text: text.trim(),
      author: await sessionEmail(supabase),
    })
    .select()
    .single()
  if (error) {
    console.error(`comments POST: ${error.message}`)
    return NextResponse.json({ error: 'Failed to add comment' }, { status: 500 })
  }
  return NextResponse.json(data, { status: 201 })
}
