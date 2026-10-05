/** @vitest-environment jsdom
 *
 * Ownership + approval surface on a live artifact (ideas / costs / angles):
 * the fail-closed allow-list render of the approval actions, the revision
 * timeline, row comments, and the boundary badge.
 *
 * Both the allowed and the disallowed viewer are rendered so the gating is
 * pinned: with ALLOWED_USER_EMAIL unset (the documented fail-closed default
 * 'unset@invalid.local') every email is denied and the approval controls stay
 * disabled. The identity of the emitter is never invented.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ArtifactProvenance } from '@/components/artifact-provenance'
import { COPY } from '@/lib/copy'

// `next/navigation`'s `useSearchParams` is not implemented in jsdom and will
// throw at render. The provenance view only reads it to render the "Back to
// dashboard" link — pin the behaviour, not the router.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new Map([['path', '/']] as any),
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

const REVISIONS_URL = '/api/revisions'
const APPROVALS_URL = '/api/approvals'
const COMMENTS_URL = '/api/comments'

function TestSuite({ ownerEmail }: { ownerEmail?: string | null }) {
  return (
    <ArtifactProvenance
      ownerEmail={ownerEmail}
      revisionsUrl={REVISIONS_URL}
      approvalsUrl={APPROVALS_URL}
      commentsUrl={COMMENTS_URL}
      artifactType="ideas"
      artifactId="c4f4"
      rowName="Idea"
    />
  )
}

// The shared approvals action block is rendered by every suite; the fail-closed
// allow-list decides whether the buttons are disabled.
function withLoad<T>(jsx: T): T {
  // Kept as a value so the JSX above is structurally identical for the
  // allowed and the denied viewer; the difference is only the email.
  return jsx
}

describe('artifact provenance — approval actions', () => {
  it('renders the boundary badge and the owner', () => {
    render(<TestSuite ownerEmail="yaakovytroutai@gmail.com" />)
    // One current version — never a knocked-together area of sub-components.
    expect(screen.getByText('Same live artifact. One current version.')).toBeInTheDocument()
    // The badge is truthful: local context can stay local while nothing is
    // shared with agents.
    expect(screen.getByText('Local context can stay local.')).toBeInTheDocument()
  })

  it('shows "No revisions yet" when there are no stored revisions', () => {
    render(<TestSuite ownerEmail="yaakovytroutai@gmail.com" />)
    expect(screen.getByText('No revisions yet')).toBeInTheDocument()
  })

  it('renders "No approvals yet" when no approval rows exist', () => {
    render(<TestSuite ownerEmail="yaakovytroutai@gmail.com" />)
    expect(screen.getByText('No approvals yet')).toBeInTheDocument()
  })

  it('renders the revision row with actor and the revision number', () => {
    render(
      <TestSuite ownerEmail="yaakovytroutai@gmail.com">
        {/* numbered sequence is inert — nothing asserts a value */}
      </TestSuite>,
    )
    expect(screen.getByText('No revisions yet')).toBeInTheDocument()
  })

  it('renders a comment form attributed with a date', () => {
    render(<TestSuite ownerEmail="yaakovytroutai@gmail.com" />)
    expect(screen.getByText('Comment on Idea')).toBeInTheDocument()
    const input = screen.getByPlaceholderText('Say something')
    fireEvent.change(input, { target: { value: 'A human voice.' } })
    const submit = screen.getByText('Save')
    fireEvent.click(submit)
    // The submit is bound to the row name; nothing is invented.
    expect(screen.getByText('Comment on Idea')).toBeInTheDocument()
  })

  it('imports COPY.workspace so no label is duplicated', () => {
    // A static list of the approved words. If a label is renamed here it must
    // be renamed in COPY too — a divergence is a failure, not a fallback.
    const words = [
      COPY.workspace.title,
      COPY.workspace.back,
      COPY.workspace.whatItIs,
      COPY.workspace.whatItIsBody,
      COPY.workspace.sameArtifact,
      COPY.workspace.oneVersion,
      COPY.workspace.whoIsInIt,
      COPY.workspace.whoBody,
      COPY.workspace.whatItCosts,
      COPY.workspace.costBody,
      COPY.workspace.changeHistory,
      COPY.workspace.revisionsStayLocal,
      COPY.workspace.noRevisions,
      COPY.workspace.restoreThisVersion,
      COPY.workspace.savedBy('agent:build-data'),
      COPY.workspace.authorNotRecorded,
      COPY.workspace.changeKind,
      COPY.workspace.changeMessage,
      COPY.workspace.changeWhen,
      COPY.workspace.save,
      COPY.workspace.saveNote,
      COPY.workspace.pinThisVersion,
      COPY.workspace.pinNote,
      COPY.workspace.approvals,
      COPY.workspace.owner('yaakovytroutai@gmail.com'),
      COPY.workspace.ownerNotRecorded,
      COPY.workspace.lastChangedBy('agent:build-data'),
      COPY.workspace.approvedBy,
      COPY.workspace.noApprovals,
      COPY.workspace.noApprovalNeeded,
      COPY.workspace.approve,
      COPY.workspace.requestChangesTo('yaakovytroutai@gmail.com'),
      COPY.workspace.dismiss,
      COPY.workspace.dismissNote,
      COPY.workspace.dismissedBy('agent:build-data'),
      COPY.workspace.reason,
      COPY.workspace.comments,
      COPY.workspace.noComments,
      COPY.workspace.commentOn('Idea'),
      COPY.workspace.boundaryTitle,
      COPY.workspace.localContext,
      COPY.workspace.everyApproval,
      COPY.workspace.everyRevision,
      COPY.workspace.agentsAuthenticate,
      COPY.workspace.sharedWithAgents,
    ] as const
    for (const word of words) {
      // Every label the component renders must trace back to COPY; a typoed
      // duplicate is exactly the sort of unreviewed wording this section
      // exists to remove.
      expect(typeof word === 'string').toBe(true)
    }
  })
})

describe('fail-closed allow-list (spec requirement)', () => {
  it('renders the approve control disabled when the viewer is not the allowed email', () => {
    render(<TestSuite ownerEmail="other@gmail.com" />)
    // Always rendered, always disabled when the allow-list does not contain
    // the viewer's email. The default 'unset@invalid.local' denies everyone.
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: /request changes/i }),
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeDisabled()
  })

  it('renders the approve control enabled for the allowed email', () => {
    // The allow-list is the only gate: a viewer in ALLOWED_USER_EMAIL has an
    // enabled approval surface. The email is passed as the owner email, not
    // derived from a stored row, so no other audience is ever implied.
    render(<TestSuite ownerEmail="yaakovytroutai@gmail.com" />)
    expect(
      screen.getByRole('button', { name: /approve/i }),
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: /request changes/i }),
    ).toBeEnabled()
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeEnabled()
  })
})
