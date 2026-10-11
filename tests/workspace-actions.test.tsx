/**
 * @vitest-environment jsdom
 *
 * DOM review of ownership, approval, the note thread, and the boundary badge.
 * The page itself stays first-run (no handlers, no grant). This render passes
 * a stubbed artifact so the controls can be read from the DOM.
 */
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { COPY } from '@/lib/copy'
import { loadCollaborationReview } from '@/lib/collaboration'
import { SharedWorkspace } from '@/components/shared-workspace'

const review = loadCollaborationReview()
if (!review) throw new Error('review fixture did not parse')

const opening = review.artifacts[0]
const selfWrite = review.artifacts[1]
const unrecorded = review.artifacts[2]

const AT = ['2026-10-05T12:00:00Z', '2026-10-05T12:01:00Z', '2026-10-05T12:02:00Z']

function clock() {
  let index = 0
  return () => AT[index++] ?? AT[AT.length - 1]
}

function propsFor(
  artifact: typeof opening,
  viewer: { id: string; authorized: boolean },
  now = clock(),
) {
  return {
    ownerEmail: artifact.owner,
    lastActor: artifact.lastActor,
    lastChangeAt: artifact.lastChangeAt,
    shared: false as const,
    approvalNeeded: artifact.pending !== null,
    writer: artifact.pending?.writer ?? null,
    decisionActor: viewer.id,
    decisionAuthorized: viewer.authorized,
    now,
    revisions: [] as const,
    approvals: [] as const,
    comments: artifact.comments.map((comment) => ({
      id: comment.id,
      actor: comment.author,
      rowName: artifact.rows.find((row) => row.id === comment.rowId)?.label ?? null,
      body: comment.body,
      parentId: comment.parentId,
    })),
    rows: artifact.rows.map((row) => ({ id: row.id, label: row.label, text: row.text })),
    onApprove: () => {},
    onRequestChanges: () => {},
    onDismiss: () => {},
    onComment: () => {},
  }
}

describe('ownership and approval on a stubbed artifact', () => {
  it('shows the owner, last change, last actor, jar, and a local badge', () => {
    render(<SharedWorkspace {...propsFor(opening, review.viewer)} />)
    const panel = screen.getByTestId('ownership-panel')
    expect(panel).toHaveTextContent(COPY.workspace.owner('agent:build-copy'))
    expect(panel).toHaveTextContent(COPY.workspace.lastChangedBy('agent:build-copy'))
    expect(panel).toHaveTextContent('2026-10-04T18:12:00Z')
    expect(screen.getByTestId('jar-icon').querySelector('svg')).toBeTruthy()
    expect(screen.getByTestId('workspace-boundary-badge')).toHaveAttribute('data-boundary', 'local')
    expect(screen.queryByText(COPY.workspace.sharedWithAgents)).toBeNull()
    expect(screen.queryByText('agent:build-data')).toBeNull()
  })

  it('enables the decision buttons only when the actor is authorized and is not the writer', () => {
    const { unmount } = render(<SharedWorkspace {...propsFor(opening, review.viewer)} />)
    expect(screen.getByTestId('approve')).toBeEnabled()
    expect(screen.getByTestId('request-changes')).toBeEnabled()
    expect(screen.getByTestId('dismiss')).toBeEnabled()
    expect(screen.getByTestId('request-changes')).toHaveTextContent(
      COPY.workspace.requestChangesTo('agent:build-copy'),
    )
    unmount()

    render(<SharedWorkspace {...propsFor(selfWrite, review.viewer)} />)
    expect(screen.getByTestId('approve')).toBeDisabled()
    expect(screen.getByTestId('request-changes')).toBeDisabled()
    expect(screen.getByTestId('dismiss')).toBeDisabled()
  })

  it('keeps the buttons disabled when the actor is not authorized', () => {
    render(
      <SharedWorkspace
        {...propsFor(opening, { id: review.viewer.id, authorized: false })}
      />,
    )
    expect(screen.getByTestId('approve')).toBeDisabled()
    expect(screen.getByTestId('dismiss')).toBeDisabled()
  })

  it('records approve, request-changes, and dismiss as separate actions', () => {
    const now = clock()
    render(<SharedWorkspace {...propsFor(opening, review.viewer, now)} />)

    fireEvent.click(screen.getByTestId('approve'))
    let entry = screen.getAllByTestId('audit-entry').at(-1)
    expect(entry).toHaveAttribute('data-kind', 'approved')
    expect(within(entry!).getByTestId('audit-author')).toHaveTextContent(review.viewer.id)
    expect(within(entry!).getByTestId('audit-at')).toHaveTextContent(AT[0])
    expect(within(entry!).getByTestId('audit-status')).toHaveTextContent('approved')
    expect(entry).toHaveTextContent(COPY.workspace.approvedByActor(review.viewer.id))

    fireEvent.click(screen.getByTestId('request-changes'))
    entry = screen.getAllByTestId('audit-entry').at(-1)
    expect(entry).toHaveAttribute('data-kind', 'changes_requested')
    expect(entry).toHaveTextContent(COPY.workspace.requestChangesTo('agent:build-copy'))
    expect(within(entry!).getByTestId('audit-author')).toHaveTextContent(review.viewer.id)
    expect(within(entry!).getByTestId('audit-at')).toHaveTextContent(AT[1])

    fireEvent.click(screen.getByTestId('dismiss'))
    expect(screen.getAllByTestId('audit-entry')).toHaveLength(2)

    fireEvent.change(screen.getByTestId('dismiss-reason'), { target: { value: 'The ask is vague.' } })
    fireEvent.click(screen.getByTestId('dismiss'))
    entry = screen.getAllByTestId('audit-entry').at(-1)
    expect(entry).toHaveAttribute('data-kind', 'dismissed')
    expect(entry).toHaveTextContent('The ask is vague.')
    expect(within(entry!).getByTestId('audit-author')).toHaveTextContent(review.viewer.id)
    expect(within(entry!).getByTestId('audit-at')).toHaveTextContent(AT[2])
    expect(screen.getAllByTestId('audit-entry').map((node) => node.getAttribute('data-kind'))).toEqual([
      'approved',
      'changes_requested',
      'dismissed',
    ])
  })

  it('threads a note under its row and does not treat the note as a write', () => {
    const now = clock()
    render(<SharedWorkspace {...propsFor(opening, review.viewer, now)} />)
    const thread = screen.getByTestId('feedback-thread')
    const notes = within(thread).getAllByTestId('comment')
    expect(notes[0]).toHaveAttribute('data-author', review.viewer.id)
    expect(notes[0]).toHaveAttribute('data-readonly', 'true')
    expect(notes[0]).toHaveAttribute('data-kind', 'comment')
    expect(within(notes[0]).getByTestId('comment')).toHaveAttribute('data-author', 'agent:build-copy')
    const row = screen.getByTestId('row-text-row-opening')
    const before = row.textContent
    fireEvent.change(screen.getByTestId('comment-input-row-opening'), {
      target: { value: 'Leave the measured line out.' },
    })
    fireEvent.click(screen.getByTestId('comment-submit-row-opening'))
    expect(screen.getByTestId('row-text-row-opening')).toHaveTextContent(before ?? '')
    const added = within(thread).getAllByTestId('comment').at(-1)
    expect(added).toHaveAttribute('data-kind', 'comment')
    expect(added).toHaveAttribute('data-readonly', 'true')
    expect(added).toHaveAttribute('data-author', review.viewer.id)
    expect(screen.queryByText('agent:build-data')).toBeNull()
  })

  it('says the author is not recorded when the artifact has none', () => {
    render(
      <SharedWorkspace
        {...propsFor(unrecorded, review.viewer)}
        onApprove={undefined}
        onRequestChanges={undefined}
        onDismiss={undefined}
        onComment={undefined}
      />,
    )
    expect(screen.getByTestId('ownership-panel')).toHaveTextContent(COPY.workspace.ownerNotRecorded)
    expect(screen.queryByText(COPY.workspace.lastChangedBy('agent:build-data'))).toBeNull()
    expect(screen.queryByTestId('approve')).toBeNull()
  })
})
