import { NextRequest, NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getRequestClient } from '@/lib/request-client'
import { nextRevisionNumber, recordRevision, readRevisionNumber, sessionEmail } from '@/lib/revisions'
import { EDITABLE_ARTIFACTS } from '@/lib/revisions'

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
  const { artifact_type, artifact_id } = body as {
    artifact_type?: unknown
    artifact_id?: unknown
  }
  if (!artifact_type || !artifact_id) {
    return NextResponse.json({ error: 'artifact_type and artifact_id required' }, { status: 400 })
  }
  const t = artifact_type as (typeof EDITABLE_ARTIFACTS)[number]
  if (!EDITABLE_ARTIFACTS.includes(t)) {
    return NextResponse.json({ error: 'artifact_type must be ideas, costs, or angles' }, { status: 400 })
  }
  const current = await readRevisionNumber(supabase, t, artifact_id as string)
  const next = nextRevisionNumber(current)
  const stamp = await recordRevision(supabase, {
    revision_id: crypto.randomUUID(),
    artifact_type: t,
    artifact_id: artifact_id as string,
    revision_number: next,
    actor: await sessionEmail(supabase),
    change_kind: 'update',
    change_message: 'restored to this version',
  })
  if ('error' in stamp) {
    console.error(`checkpoints restore: ${stamp.error}`)
    return NextResponse.json({ error: 'Failed to record restore' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, next_revision: next })
}
