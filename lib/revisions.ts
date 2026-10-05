import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Revision history for the three agent-edited objects: ideas, costs, angles.
 *
 * actor is the signed-in email, or `agent:<profile-name>` when a fleet write
 * sends that header. Anything else is NULL — the source did not say. Never
 * invent an email, and never accept a client-supplied email as the actor.
 */

export const EDITABLE_ARTIFACTS = ['ideas', 'costs', 'angles'] as const
export type ArtifactType = (typeof EDITABLE_ARTIFACTS)[number]
export type ChangeKind = 'create' | 'update' | 'delete'

const AGENT_ACTOR = /^agent:[a-z0-9][a-z0-9_-]{0,63}$/i

type ActorSource = {
  headers?: { get(name: string): string | null }
}

type AuthClient = {
  auth?: {
    getUser?: () => Promise<{ data?: { user?: { email?: string | null } | null } }>
  }
}

export type AuditStamp = {
  revision_id: string
  revision_number: number
  change_kind: ChangeKind
  change_message: string | null
  actor: string | null
}

export function resolveActor(request: ActorSource, sessionEmail: string | null): string | null {
  const header = request.headers?.get('x-actor')?.trim() ?? ''
  if (AGENT_ACTOR.test(header)) return header
  if (sessionEmail && sessionEmail.includes('@')) return sessionEmail
  return null
}

export function changeMessageFrom(body: Record<string, unknown>): string | null {
  return typeof body.change_message === 'string' ? body.change_message : null
}

/**
 * NULL means no prior revision was stored. The first one we record is 1.
 * A stored number is incremented; 0 is a measurement, not rewritten into NULL.
 */
export function nextRevisionNumber(current: number | null): number {
  if (typeof current === 'number' && Number.isFinite(current)) return current + 1
  return 1
}

export async function sessionEmail(supabase: SupabaseClient): Promise<string | null> {
  const getUser = (supabase as AuthClient).auth?.getUser
  if (typeof getUser !== 'function') return null
  try {
    const { data } = await getUser()
    const email = data?.user?.email
    return typeof email === 'string' && email.includes('@') ? email : null
  } catch {
    return null
  }
}

export async function readRevisionNumber(
  supabase: SupabaseClient,
  table: ArtifactType,
  id: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from(table)
    .select('revision_number')
    .eq('id', id)
    .maybeSingle()
  if (error || data == null) return null
  const row = (Array.isArray(data) ? data[0] : data) as { revision_number?: unknown } | undefined
  const value = row?.revision_number
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function auditStamp(
  supabase: SupabaseClient,
  request: ActorSource,
  input: {
    artifactType: ArtifactType
    artifactId: string | null
    changeKind: ChangeKind
    changeMessage: string | null
  },
): Promise<AuditStamp> {
  const prior =
    input.changeKind === 'create' || !input.artifactId
      ? null
      : await readRevisionNumber(supabase, input.artifactType, input.artifactId)
  return {
    revision_id: crypto.randomUUID(),
    revision_number: input.changeKind === 'create' ? 1 : nextRevisionNumber(prior),
    change_kind: input.changeKind,
    change_message: input.changeMessage,
    actor: resolveActor(request, await sessionEmail(supabase)),
  }
}

export async function recordRevision(
  supabase: SupabaseClient,
  row: {
    revision_id: string
    artifact_type: ArtifactType
    artifact_id: string
    revision_number: number
    actor: string | null
    change_kind: ChangeKind
    change_message: string | null
  },
): Promise<{ ok: true } | { error: string }> {
  if (!row.artifact_id) return { error: 'revision upsert failed: artifact id missing' }
  const { error } = await supabase.from('revisions').upsert(
    {
      id: row.revision_id,
      artifact_type: row.artifact_type,
      artifact_id: row.artifact_id,
      revision_number: row.revision_number,
      actor: row.actor,
      change_kind: row.change_kind,
      change_message: row.change_message,
    },
    { onConflict: 'artifact_type,artifact_id,revision_number' },
  )
  if (error) return { error: error.message || 'revision upsert failed' }
  return { ok: true }
}
