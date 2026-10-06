import { describe, it, expect } from 'vitest'
import { applyAction, canDecide, loadCollaborationReview } from '@/lib/collaboration'

const review = loadCollaborationReview()
if (!review) throw new Error('review fixture did not parse')

const artifact = review.artifacts[0]
const viewer = review.viewer
const at = '2026-10-05T12:00:00Z'

describe('approval actions stay distinct from a note', () => {
  it('refuses a decision from the writer and from an unauthorized actor', () => {
    expect(canDecide(viewer, artifact).ok).toBe(true)
    expect(canDecide({ id: artifact.pending!.writer, authorized: true }, artifact).reason).toBe(
      'is_writer',
    )
    expect(canDecide({ id: viewer.id, authorized: false }, artifact).reason).toBe('not_authorized')
  })

  it('records approve, request-changes, and dismiss with author, time, and status', () => {
    const approved = applyAction(artifact, viewer, { kind: 'approve' }, at)
    expect(approved.ok).toBe(true)
    if (!approved.ok) return
    expect(approved.artifact.pending?.status).toBe('approved')
    expect(approved.artifact.actions.at(-1)).toMatchObject({
      kind: 'approve',
      author: viewer.id,
      at,
      status: 'approved',
      readOnly: false,
    })

    const asked = applyAction(
      artifact,
      viewer,
      { kind: 'request_changes', targetOwner: 'agent:build-copy' },
      at,
    )
    expect(asked.ok).toBe(true)
    if (!asked.ok) return
    expect(asked.artifact.actions.at(-1)?.targetOwner).toBe('agent:build-copy')
    expect(asked.artifact.actions.at(-1)?.kind).toBe('request_changes')

    const bare = applyAction(artifact, viewer, { kind: 'dismiss', reason: '  ' }, at)
    expect(bare.ok).toBe(false)
    const dismissed = applyAction(artifact, viewer, { kind: 'dismiss', reason: 'Vague ask.' }, at)
    expect(dismissed.ok).toBe(true)
    if (!dismissed.ok) return
    expect(dismissed.artifact.actions.at(-1)).toMatchObject({
      kind: 'dismiss',
      author: viewer.id,
      at,
      status: 'dismissed',
      reason: 'Vague ask.',
    })
  })

  it('treats a comment as read-only and a write as a change to the row', () => {
    const before = artifact.rows[0].text
    const noted = applyAction(
      artifact,
      viewer,
      { kind: 'comment', rowId: artifact.rows[0].id, parentId: null, body: 'A note.' },
      at,
    )
    expect(noted.ok).toBe(true)
    if (!noted.ok) return
    expect(noted.artifact.rows[0].text).toBe(before)
    expect(noted.artifact.actions.at(-1)).toMatchObject({ kind: 'comment', readOnly: true, author: viewer.id })

    const written = applyAction(
      artifact,
      viewer,
      { kind: 'write', rowId: artifact.rows[0].id, body: 'A different sentence.' },
      at,
    )
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.artifact.rows[0].text).toBe('A different sentence.')
    expect(written.artifact.actions.at(-1)).toMatchObject({ kind: 'write', readOnly: false })
    expect(written.artifact.lastActor).toBe(viewer.id)
  })

  it('does not invent an author', () => {
    const missing = applyAction(artifact, { id: '  ', authorized: true }, { kind: 'approve' }, at)
    expect(missing.ok).toBe(false)
    expect(missing.artifact).toBe(artifact)
  })
})
