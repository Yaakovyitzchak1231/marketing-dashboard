import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Revision history for the three agent-edited objects: ideas, costs, angles.
 *
 * actor is the signed-in email, or `agent:<profile-name>` when a fleet write
 * sends that header. Anything else is NULL — the source did not say. Never
 * invent an email, and never accept a client-supplied email as the actor.
 *
 * 007 adds the two interactivity features this module drives:
 *   - restore-to-revision-N: rewrites the live row's business columns from a
 *     stored snapshot and records a NEW revision (change_kind 'restore'),
 *     stamped with the restoring actor, never the original author.
 *   - checkpoints: a named capture of the current heads (per-object latest
 *     revision), one of which is the default the workspace opens.
 */

export const EDITABLE_ARTIFACTS = ['ideas', 'costs', 'angles'] as const
export type ArtifactType = (typeof EDITABLE_ARTIFACTS)[number]
export type ChangeKind = 'create' | 'update' | 'delete'
export type StoredChangeKind = ChangeKind | 'restore'

/** The single owner. Restore authorization and RLS are both scoped to this. */
export const OWNER_EMAIL = 'yaakovytroutai@gmail.com'

const AGENT_ACTOR = /^agent:[a-z0-9][a-z0-9_-]{0,63}$/i

/**
 * The business columns each artifact table actually holds — the columns an
 * edit or a restore writes. Audit columns (revision_id, revision_number,
 * change_kind, change_message, actor) and system columns (id, created_at,
 * updated_at) are deliberately excluded: a snapshot captures the row's
 * content, and a restore must never resurrect an old audit stamp.
 */
export const BUSINESS_COLUMNS: Record<ArtifactType, readonly string[]> = {
  ideas: ['title', 'hypothesis', 'status'],
  costs: ['cost_date', 'category', 'entity_ref', 'amount_usd', 'notes'],
  angles: ['campaign_id', 'name', 'step', 'subject'],
}

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

/**
 * Pick only the business columns out of a row (the content a restore would
 * write). Returns an empty object when the row is missing — a snapshot of
 * nothing is honest, a fabricated row is not.
 */
export function businessSnapshot(
  table: ArtifactType,
  row: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const columns = BUSINESS_COLUMNS[table]
  const out: Record<string, unknown> = {}
  if (!row) return out
  for (const column of columns) {
    if (column in row) out[column] = row[column]
  }
  return out
}

export async function recordRevision(
  supabase: SupabaseClient,
  row: {
    revision_id: string
    artifact_type: ArtifactType
    artifact_id: string
    revision_number: number
    actor: string | null
    change_kind: StoredChangeKind
    change_message: string | null
    snapshot?: Record<string, unknown> | null
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
      snapshot: row.snapshot ?? null,
    },
    { onConflict: 'artifact_type,artifact_id,revision_number' },
  )
  if (error) return { error: error.message || 'revision upsert failed' }
  return { ok: true }
}

export type StoredRevision = {
  revision_number: number
  actor: string | null
  change_kind: string | null
  change_message: string | null
  snapshot: Record<string, unknown> | null
  created_at: string
}

export async function readRevision(
  supabase: SupabaseClient,
  table: ArtifactType,
  id: string,
  revisionNumber: number,
): Promise<StoredRevision | null> {
  const { data, error } = await supabase
    .from('revisions')
    .select('revision_number, actor, change_kind, change_message, snapshot, created_at')
    .eq('artifact_type', table)
    .eq('artifact_id', id)
    .eq('revision_number', revisionNumber)
    .maybeSingle()
  if (error || data == null) return null
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined
  if (!row) return null
  const snapshot = row.snapshot
  return {
    revision_number: typeof row.revision_number === 'number' ? row.revision_number : revisionNumber,
    actor: typeof row.actor === 'string' ? row.actor : null,
    change_kind: typeof row.change_kind === 'string' ? row.change_kind : null,
    change_message: typeof row.change_message === 'string' ? row.change_message : null,
    snapshot: snapshot && typeof snapshot === 'object' ? (snapshot as Record<string, unknown>) : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
  }
}

/**
 * A restore may be performed only by the owner, or by an agent that has
 * already written a revision on this exact object. A NULL actor — the source
 * did not say — is refused outright. This is the guardrail, in code.
 */
export async function canRestore(
  supabase: SupabaseClient,
  table: ArtifactType,
  id: string,
  actor: string | null,
): Promise<boolean> {
  if (!actor) return false
  if (actor === OWNER_EMAIL) return true
  if (!AGENT_ACTOR.test(actor)) return false
  // Agent: allowed only if it already touched this object.
  const { data, error } = await supabase
    .from('revisions')
    .select('actor')
    .eq('artifact_type', table)
    .eq('artifact_id', id)
    .eq('actor', actor)
    .limit(1)
  if (error) return false
  return Array.isArray(data) && data.length > 0
}

export type RestoreResult =
  | { restored: Record<string, unknown>; revision: StoredRevision }
  | { error: string; status: number }

/**
 * Restore the live row to the business columns stored at `revisionNumber`.
 * The write is stamped with the RESTORING actor (resolveActor), not the
 * original author: copying the old audit columns would claim the original
 * author wrote again. Records a new revision with change_kind 'restore'.
 */
export async function restoreRevision(
  supabase: SupabaseClient,
  request: ActorSource,
  input: {
    artifactType: ArtifactType
    artifactId: string
    revisionNumber: number
    changeMessage: string | null
  },
): Promise<RestoreResult> {
  const actor = resolveActor(request, await sessionEmail(supabase))

  if (!(await canRestore(supabase, input.artifactType, input.artifactId, actor))) {
    return {
      error: 'Not authorized to restore this object',
      status: 403,
    }
  }

  const target = await readRevision(
    supabase,
    input.artifactType,
    input.artifactId,
    input.revisionNumber,
  )
  if (!target) {
    return { error: 'Revision not found', status: 404 }
  }
  if (target.change_kind === 'delete') {
    return { error: 'Cannot restore a delete revision', status: 409 }
  }
  if (!target.snapshot) {
    return { error: 'This revision has no stored snapshot', status: 409 }
  }

  const prior = await readRevisionNumber(supabase, input.artifactType, input.artifactId)
  const stamp = {
    revision_id: crypto.randomUUID(),
    revision_number: nextRevisionNumber(prior),
    change_kind: 'restore' as StoredChangeKind,
    change_message: input.changeMessage,
    actor,
  }

  const { data, error } = await supabase
    .from(input.artifactType)
    .update({ ...target.snapshot, ...stamp })
    .eq('id', input.artifactId)
    .select()
    .single()
  if (error) {
    return { error: 'Failed to restore row', status: 500 }
  }
  const restored = (data ?? null) as Record<string, unknown> | null
  if (!restored) {
    return { error: 'Failed to restore row', status: 500 }
  }

  const recorded = await recordRevision(supabase, {
    revision_id: stamp.revision_id,
    artifact_type: input.artifactType,
    artifact_id: input.artifactId,
    revision_number: stamp.revision_number,
    actor: stamp.actor,
    change_kind: 'restore',
    change_message: stamp.change_message,
    snapshot: target.snapshot,
  })
  if ('error' in recorded) {
    return { error: recorded.error, status: 500 }
  }

  return {
    restored,
    revision: {
      revision_number: stamp.revision_number,
      actor: stamp.actor,
      change_kind: 'restore',
      change_message: stamp.change_message,
      snapshot: target.snapshot,
      created_at: '',
    },
  }
}

export type CheckpointHead = {
  artifact_type: ArtifactType
  artifact_id: string
  revision_number: number
}

export type Checkpoint = {
  id: string
  name: string
  actor: string | null
  heads: CheckpointHead[]
  is_default: boolean
  created_at: string
}

/**
 * The current heads: for each (artifact_type, artifact_id), the latest
 * revision_number on the timeline. Computed from the revisions table — the
 * timeline is the source of truth, not the live rows' audit columns.
 */
export async function currentHeads(supabase: SupabaseClient): Promise<CheckpointHead[]> {
  const { data, error } = await supabase
    .from('revisions')
    .select('artifact_type, artifact_id, revision_number')
  if (error || !Array.isArray(data)) return []
  const heads = new Map<string, CheckpointHead>()
  for (const row of data as Array<Record<string, unknown>>) {
    const artifact_type = row.artifact_type as ArtifactType | undefined
    const artifact_id = typeof row.artifact_id === 'string' ? row.artifact_id : null
    const revision_number =
      typeof row.revision_number === 'number' ? row.revision_number : null
    if (!artifact_type || !artifact_id || revision_number == null) continue
    if (!EDITABLE_ARTIFACTS.includes(artifact_type)) continue
    const key = `${artifact_type}:${artifact_id}`
    const existing = heads.get(key)
    if (!existing || revision_number > existing.revision_number) {
      heads.set(key, { artifact_type, artifact_id, revision_number })
    }
  }
  return [...heads.values()].sort((a, b) =>
    a.artifact_type === b.artifact_type
      ? a.artifact_id.localeCompare(b.artifact_id)
      : a.artifact_type.localeCompare(b.artifact_type),
  )
}

export type CheckpointResult =
  | { checkpoint: Checkpoint }
  | { error: string; status: number }

function toCheckpoint(row: Record<string, unknown>): Checkpoint | null {
  if (!row || typeof row.id !== 'string') return null
  const rawHeads = row.heads
  const heads: CheckpointHead[] = Array.isArray(rawHeads)
    ? (rawHeads as Array<Record<string, unknown>>)
        .filter(
          h =>
            h &&
            typeof h.artifact_type === 'string' &&
            EDITABLE_ARTIFACTS.includes(h.artifact_type as ArtifactType) &&
            typeof h.artifact_id === 'string' &&
            typeof h.revision_number === 'number',
        )
        .map(h => ({
          artifact_type: h.artifact_type as ArtifactType,
          artifact_id: h.artifact_id as string,
          revision_number: h.revision_number as number,
        }))
    : []
  return {
    id: row.id as string,
    name: typeof row.name === 'string' ? row.name : '',
    actor: typeof row.actor === 'string' ? row.actor : null,
    heads,
    is_default: row.is_default === true,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
  }
}

/**
 * Save a named checkpoint of the current heads. A missing or empty name uses
 * a timestamp (the app's accepted default) — never a composed marketing title.
 */
export async function saveCheckpoint(
  supabase: SupabaseClient,
  request: ActorSource,
  input: { name: string | null },
): Promise<CheckpointResult> {
  const name = input.name?.trim() || new Date().toISOString()
  const actor = resolveActor(request, await sessionEmail(supabase))
  const heads = await currentHeads(supabase)
  const { data, error } = await supabase
    .from('checkpoints')
    .insert({ name, actor, heads, is_default: false })
    .select()
    .single()
  if (error || !data) {
    return { error: error?.message || 'Failed to save checkpoint', status: 500 }
  }
  const checkpoint = toCheckpoint(data as Record<string, unknown>)
  if (!checkpoint) return { error: 'Failed to save checkpoint', status: 500 }
  return { checkpoint }
}

/**
 * Pin a checkpoint as the default the workspace opens. Exactly one default:
 * clear the old default first, then mark the new one.
 */
export async function pinCheckpoint(
  supabase: SupabaseClient,
  input: { id: string },
): Promise<CheckpointResult> {
  const { error: clearError } = await supabase
    .from('checkpoints')
    .update({ is_default: false })
    .eq('is_default', true)
  if (clearError) {
    return { error: clearError.message || 'Failed to clear default checkpoint', status: 500 }
  }
  const { data, error } = await supabase
    .from('checkpoints')
    .update({ is_default: true })
    .eq('id', input.id)
    .select()
    .single()
  if (error || !data) {
    return { error: error?.message || 'Checkpoint not found', status: 404 }
  }
  const checkpoint = toCheckpoint(data as Record<string, unknown>)
  if (!checkpoint) return { error: 'Checkpoint not found', status: 404 }
  return { checkpoint }
}
