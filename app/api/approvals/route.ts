import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'
import { EDITABLE_ARTIFACTS, sessionEmail } from '@/lib/revisions'

const ARTIFACT_TYPES = EDITABLE_ARTIFACTS
const STATUSES = ['approved', 'requested', 'dismissed'] as const

/**
 * Approvals: the action surface the provenance panel reads and writes.
 * GET lists approvals for one artifact. POST records one approval row.
 * Writes ride RLS as the signed-in user — actor is the session email, or
 * NULL when the source did not say. Never a client-supplied email.
 */
export async function GET(req: NextRequest) {
  const supabase = await getRequestClient(req)
  if (!supabase) return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  const url = new URL(req.url)
  const artifactType = url.searchParams.get('artifact_type') ?? ''
  const artifactId = url.searchParams.get('artifact_id') ?? ''
  if (!ARTIFACT_TYPES.includes(artifactType as (typeof ARTIFACT_TYPES)[number])) {
    return NextResponse.json(
      { error: 'artifact_type must be ideas, costs, or angles' },
      { status: 400 },
    )
  }
  if (!artifactId) {
    return NextResponse.json({ error: 'artifact_id is required' }, { status: 400 })
  }
  const { data, error } = await supabase
    .from('approvals')
    .select('*')
    .eq('artifact_type', artifactType)
    .eq('artifact_id', artifactId)
    .order('created_at', { ascending: false })
  if (error) {
    console.error(`approvals GET: ${error.message}`)
    return NextResponse.json({ error: 'Failed to fetch approvals' }, { status: 500 })
  }
  return NextResponse.json((data ?? []) as Array<Record<string, unknown>>)
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
  const { artifact_type, artifact_id, status, owner, reason } = body as {
    artifact_type?: unknown
    artifact_id?: unknown
    status?: unknown
    owner?: unknown
    reason?: unknown
  }
  if (!artifact_type || !artifact_id || !status) {
    return NextResponse.json(
      { error: 'artifact_type, artifact_id, status required' },
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
  if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json(
      { error: 'status must be approved, requested, or dismissed' },
      { status: 400 },
    )
  }
  // owner is a display string only. actor is the session email or NULL.
  const { data, error } = await supabase
    .from('approvals')
    .insert({
      artifact_type: t,
      artifact_id: artifact_id as string,
      status,
      actor: await sessionEmail(supabase),
      owner: typeof owner === 'string' ? owner : null,
      reason: typeof reason === 'string' ? reason : null,
    })
    .select()
    .single()
  if (error) {
    console.error(`approvals POST: ${error.message}`)
    return NextResponse.json({ error: 'Failed to record approval' }, { status: 500 })
  }
  return NextResponse.json(data, { status: 201 })
}
