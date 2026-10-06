/**
 * Collaboration contract for one artifact.
 *
 * This is a label and an audit trail. It does not grant access, publish a
 * link, or consult a policy. Who may sign in stays where it already is:
 * the single-owner email gate. A missing owner stays missing.
 */

import fixture from './collaboration-fixture.json'

export type BoundaryState = 'local' | 'shared'

export type DecisionStatus =
  | 'pending'
  | 'approved'
  | 'changes_requested'
  | 'dismissed'

export type ActionKind =
  | 'approve'
  | 'request_changes'
  | 'dismiss'
  | 'comment'
  | 'write'
  | 'boundary'

export type GateReason =
  | 'open'
  | 'nothing_pending'
  | 'already_decided'
  | 'not_authorized'
  | 'is_writer'

export type ApplyError =
  | Exclude<GateReason, 'open'>
  | 'reason_required'
  | 'owner_required'
  | 'body_required'
  | 'actor_required'
  | 'row_missing'

export type CollaborationAction = {
  id: string
  kind: ActionKind
  author: string
  at: string
  status: string
  readOnly: boolean
  reason?: string
  targetOwner?: string
  rowId?: string
  parentId?: string | null
  body?: string
}

export type ArtifactRow = {
  id: string
  label: string
  text: string
}

export type ArtifactComment = {
  id: string
  rowId: string
  parentId: string | null
  author: string
  body: string
  at: string
}

export type PendingChange = {
  id: string
  summary: string
  writer: string
  at: string
  status: DecisionStatus
}

export type CollaborationArtifact = {
  id: string
  title: string
  owner: string | null
  lastChangeAt: string | null
  lastActor: string | null
  boundary: BoundaryState
  rows: ArtifactRow[]
  pending: PendingChange | null
  comments: ArtifactComment[]
  actions: CollaborationAction[]
}

export type Viewer = {
  id: string
  authorized: boolean
}

export type CollaborationReview = {
  viewer: Viewer
  artifacts: CollaborationArtifact[]
}

export type ActionInput =
  | { kind: 'approve' }
  | { kind: 'request_changes'; targetOwner: string }
  | { kind: 'dismiss'; reason: string }
  | { kind: 'comment'; rowId: string; parentId: string | null; body: string }
  | { kind: 'write'; rowId: string; body: string }
  | { kind: 'boundary' }

export type ApplyResult =
  | { ok: true; artifact: CollaborationArtifact }
  | { ok: false; artifact: CollaborationArtifact; error: ApplyError }

const DECISION_STATUSES: readonly DecisionStatus[] = [
  'pending',
  'approved',
  'changes_requested',
  'dismissed',
]

const BOUNDARIES: readonly BoundaryState[] = ['local', 'shared']

/**
 * A line drawing of a jar. Geometry lives here, not in the render path,
 * so a layout constant cannot be mistaken for a metric.
 * aria-hidden: the badge text is the accessible name.
 */
export const JAR_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"><path d="M5 2.5h6M4.5 4.25h7V6c0 2.2-.7 3.8-1.15 5.6-.2.8-.75 1.4-1.55 1.4H7.2c-.8 0-1.35-.6-1.55-1.4C5.2 9.8 4.5 8.2 4.5 6V4.25z"/></svg>'

export function canDecide(
  viewer: Viewer,
  artifact: CollaborationArtifact,
): { ok: boolean; reason: GateReason } {
  if (!artifact.pending) return { ok: false, reason: 'nothing_pending' }
  if (artifact.pending.status !== 'pending') {
    return { ok: false, reason: 'already_decided' }
  }
  if (!viewer.authorized) return { ok: false, reason: 'not_authorized' }
  if (!viewer.id || viewer.id === artifact.pending.writer) {
    return { ok: false, reason: 'is_writer' }
  }
  return { ok: true, reason: 'open' }
}

function cloneArtifact(artifact: CollaborationArtifact): CollaborationArtifact {
  return JSON.parse(JSON.stringify(artifact)) as CollaborationArtifact
}

function nextId(kind: string, at: string, count: number): string {
  return `${kind}:${at}:${count}`
}

function knownActor(viewer: Viewer): boolean {
  return viewer.id.trim().length > 0
}

export function applyAction(
  artifact: CollaborationArtifact,
  viewer: Viewer,
  input: ActionInput,
  at: string,
): ApplyResult {
  if (!knownActor(viewer)) {
    return { ok: false, artifact, error: 'actor_required' }
  }
  if (!at.trim()) {
    return { ok: false, artifact, error: 'actor_required' }
  }

  if (
    input.kind === 'approve' ||
    input.kind === 'request_changes' ||
    input.kind === 'dismiss'
  ) {
    const gate = canDecide(viewer, artifact)
    if (!gate.ok) return { ok: false, artifact, error: gate.reason as ApplyError }
  }

  if (input.kind === 'request_changes' && !input.targetOwner.trim()) {
    return { ok: false, artifact, error: 'owner_required' }
  }
  if (input.kind === 'dismiss' && !input.reason.trim()) {
    return { ok: false, artifact, error: 'reason_required' }
  }
  if (
    (input.kind === 'comment' || input.kind === 'write') &&
    !input.body.trim()
  ) {
    return { ok: false, artifact, error: 'body_required' }
  }
  if (
    (input.kind === 'comment' || input.kind === 'write') &&
    !artifact.rows.some((row) => row.id === input.rowId)
  ) {
    return { ok: false, artifact, error: 'row_missing' }
  }

  const next = cloneArtifact(artifact)
  const id = nextId(input.kind, at, next.actions.length)

  if (input.kind === 'approve' && next.pending) {
    next.pending.status = 'approved'
    next.actions.push({
      id,
      kind: 'approve',
      author: viewer.id,
      at,
      status: 'approved',
      readOnly: false,
    })
    return { ok: true, artifact: next }
  }

  if (input.kind === 'request_changes' && next.pending) {
    const targetOwner = input.targetOwner.trim()
    next.pending.status = 'changes_requested'
    next.actions.push({
      id,
      kind: 'request_changes',
      author: viewer.id,
      at,
      status: 'changes_requested',
      readOnly: false,
      targetOwner,
    })
    return { ok: true, artifact: next }
  }

  if (input.kind === 'dismiss' && next.pending) {
    const reason = input.reason.trim()
    next.pending.status = 'dismissed'
    next.actions.push({
      id,
      kind: 'dismiss',
      author: viewer.id,
      at,
      status: 'dismissed',
      readOnly: false,
      reason,
    })
    return { ok: true, artifact: next }
  }

  if (input.kind === 'comment') {
    const body = input.body.trim()
    next.comments.push({
      id,
      rowId: input.rowId,
      parentId: input.parentId,
      author: viewer.id,
      body,
      at,
    })
    next.actions.push({
      id,
      kind: 'comment',
      author: viewer.id,
      at,
      status: 'noted',
      readOnly: true,
      rowId: input.rowId,
      parentId: input.parentId,
      body,
    })
    return { ok: true, artifact: next }
  }

  if (input.kind === 'write') {
    const body = input.body.trim()
    const row = next.rows.find((item) => item.id === input.rowId)
    if (!row) return { ok: false, artifact, error: 'row_missing' }
    row.text = body
    next.lastActor = viewer.id
    next.lastChangeAt = at
    if (next.pending && next.pending.status === 'pending') {
      next.pending.writer = viewer.id
      next.pending.at = at
    }
    next.actions.push({
      id,
      kind: 'write',
      author: viewer.id,
      at,
      status: 'written',
      readOnly: false,
      rowId: input.rowId,
      body,
    })
    return { ok: true, artifact: next }
  }

  if (input.kind === 'boundary') {
    const boundary: BoundaryState = next.boundary === 'local' ? 'shared' : 'local'
    next.boundary = boundary
    next.actions.push({
      id,
      kind: 'boundary',
      author: viewer.id,
      at,
      status: boundary,
      readOnly: true,
    })
    return { ok: true, artifact: next }
  }

  return { ok: false, artifact, error: 'nothing_pending' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null
  return asString(value)
}

function asBoundary(value: unknown): BoundaryState | undefined {
  return BOUNDARIES.find((item) => item === value)
}

function asStatus(value: unknown): DecisionStatus | undefined {
  return DECISION_STATUSES.find((item) => item === value)
}

function parseRow(value: unknown): ArtifactRow | undefined {
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  const label = asString(value.label)
  const text = asString(value.text)
  if (!id || label === undefined || text === undefined) return undefined
  return { id, label, text }
}

function parseComment(value: unknown): ArtifactComment | undefined {
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  const rowId = asString(value.rowId)
  const author = asString(value.author)
  const body = asString(value.body)
  const at = asString(value.at)
  const parentId = asStringOrNull(value.parentId)
  if (!id || !rowId || !author || body === undefined || !at || parentId === undefined) {
    return undefined
  }
  return { id, rowId, parentId, author, body, at }
}

function parseAction(value: unknown): CollaborationAction | undefined {
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  const kind = asString(value.kind)
  const author = asString(value.author)
  const at = asString(value.at)
  const status = asString(value.status)
  if (!id || !kind || !author || !at || status === undefined) return undefined
  if (
    kind !== 'approve' &&
    kind !== 'request_changes' &&
    kind !== 'dismiss' &&
    kind !== 'comment' &&
    kind !== 'write' &&
    kind !== 'boundary'
  ) {
    return undefined
  }
  if (typeof value.readOnly !== 'boolean') return undefined
  const action: CollaborationAction = {
    id,
    kind,
    author,
    at,
    status,
    readOnly: value.readOnly,
  }
  const reason = asString(value.reason)
  const targetOwner = asString(value.targetOwner)
  const rowId = asString(value.rowId)
  const body = asString(value.body)
  if (reason !== undefined) action.reason = reason
  if (targetOwner !== undefined) action.targetOwner = targetOwner
  if (rowId !== undefined) action.rowId = rowId
  if (body !== undefined) action.body = body
  if ('parentId' in value) {
    const parentId = asStringOrNull(value.parentId)
    if (parentId === undefined) return undefined
    action.parentId = parentId
  }
  return action
}

function parsePending(value: unknown): PendingChange | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  const summary = asString(value.summary)
  const writer = asString(value.writer)
  const at = asString(value.at)
  const status = asStatus(value.status)
  if (!id || summary === undefined || !writer || !at || !status) return undefined
  return { id, summary, writer, at, status }
}

function parseArtifact(value: unknown): CollaborationArtifact | undefined {
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  const title = asString(value.title)
  const owner = asStringOrNull(value.owner)
  const lastChangeAt = asStringOrNull(value.lastChangeAt)
  const lastActor = asStringOrNull(value.lastActor)
  const boundary = asBoundary(value.boundary)
  const pending = parsePending(value.pending)
  if (
    !id ||
    title === undefined ||
    owner === undefined ||
    lastChangeAt === undefined ||
    lastActor === undefined ||
    !boundary ||
    pending === undefined ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.comments) ||
    !Array.isArray(value.actions)
  ) {
    return undefined
  }
  const rows: ArtifactRow[] = []
  for (const row of value.rows) {
    const parsed = parseRow(row)
    if (!parsed) return undefined
    rows.push(parsed)
  }
  const comments: ArtifactComment[] = []
  for (const comment of value.comments) {
    const parsed = parseComment(comment)
    if (!parsed) return undefined
    comments.push(parsed)
  }
  const actions: CollaborationAction[] = []
  for (const action of value.actions) {
    const parsed = parseAction(action)
    if (!parsed) return undefined
    actions.push(parsed)
  }
  return {
    id,
    title,
    owner,
    lastChangeAt,
    lastActor,
    boundary,
    rows,
    pending,
    comments,
    actions,
  }
}

export function parseCollaborationReview(input: unknown): CollaborationReview | null {
  if (!isRecord(input) || !isRecord(input.viewer) || !Array.isArray(input.artifacts)) {
    return null
  }
  const id = asString(input.viewer.id)
  if (!id || typeof input.viewer.authorized !== 'boolean') return null
  const artifacts: CollaborationArtifact[] = []
  for (const item of input.artifacts) {
    const parsed = parseArtifact(item)
    if (!parsed) return null
    artifacts.push(parsed)
  }
  return { viewer: { id, authorized: input.viewer.authorized }, artifacts }
}

/** The review fixture, parsed. Null means the file does not match the contract. */
export function loadCollaborationReview(): CollaborationReview | null {
  return parseCollaborationReview(fixture)
}
