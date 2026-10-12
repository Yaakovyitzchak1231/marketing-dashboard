/** @vitest-environment jsdom
 *
 * Process guard for the d22e112 regression: a pre-fix snapshot of
 * artifact-provenance.tsx reintroduced hardcoded fallbacks ('agent', 'owner')
 * for nullable approval actor/owner. A source grep would not catch a later
 * restore of that snapshot. This asserts the rendered text.
 *
 * A stored actor of "agent" is a fact and must still render. These fixtures
 * use null, which is what the live approvals table mostly stores.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ArtifactProvenance } from '@/components/artifact-provenance'
import { COPY } from '@/lib/copy'

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

const api = vi.fn()

vi.mock('@/components/use-api', () => ({
  useApi: () => api,
}))

const NULL_APPROVALS = [
  {
    id: 'ap-null',
    actor: null,
    status: 'approved',
    owner: null,
    reason: null,
    created_at: '2026-10-06T12:00:00.000Z',
  },
  {
    id: 'rq-null',
    actor: null,
    status: 'requested',
    owner: null,
    reason: null,
    created_at: '2026-10-06T12:01:00.000Z',
  },
  {
    id: 'ds-null',
    actor: null,
    status: 'dismissed',
    owner: null,
    reason: 'kept',
    created_at: '2026-10-06T12:02:00.000Z',
  },
]

const RECORDED_APPROVAL = {
  id: 'ap-real',
  actor: 'yaakovytroutai@gmail.com',
  status: 'approved',
  owner: 'yaakovytroutai@gmail.com',
  reason: null,
  created_at: '2026-10-06T12:03:00.000Z',
}

function installApi(approvals: unknown[]) {
  api.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/approvals')) return approvals
    if (path.startsWith('/api/revisions')) {
      return [
        {
          id: 'rev-null',
          revision_number: 1,
          actor: null,
          change_kind: 'edit',
          change_message: null,
          created_at: '2026-10-06T11:00:00.000Z',
        },
      ]
    }
    return []
  })
}

function renderPanel() {
  return render(
    <ArtifactProvenance
      ownerEmail="yaakovytroutai@gmail.com"
      revisionsUrl="/api/revisions"
      approvalsUrl="/api/approvals"
      commentsUrl="/api/comments"
      artifactType="ideas"
      artifactId="c4f4"
      rowName="Idea"
    />,
  )
}

describe('approval actor honesty', () => {
  beforeEach(() => {
    api.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('does not invent agent or owner when the stored actor and owner are null', async () => {
    installApi(NULL_APPROVALS)
    renderPanel()

    const approved = COPY.workspace.approvedByActor(COPY.workspace.authorNotRecorded)
    const requested = COPY.workspace.requestChangesTo(COPY.workspace.ownerNotRecorded)
    const dismissed = COPY.workspace.dismissedBy(COPY.workspace.authorNotRecorded)

    await waitFor(() => {
      expect(screen.getByText(approved)).toBeInTheDocument()
    })
    expect(screen.getByText(requested)).toBeInTheDocument()
    expect(screen.getByText(dismissed)).toBeInTheDocument()

    // The invented literals the pre-fix snapshot rendered. Assert the
    // rendered strings, not the source.
    expect(screen.queryByText(COPY.workspace.approvedByActor('agent'))).toBeNull()
    expect(screen.queryByText(COPY.workspace.dismissedBy('agent'))).toBeNull()
    expect(screen.queryByText(COPY.workspace.requestChangesTo('owner'))).toBeNull()

    // Revision column already uses actorOrDefault. Pin that too, so a
    // snapshot restore cannot invent an actor there either.
    expect(screen.getAllByText(COPY.workspace.authorNotRecorded).length).toBeGreaterThan(0)
  })

  it('renders a stored actor and owner instead of the not-recorded fallback', async () => {
    installApi([RECORDED_APPROVAL])
    renderPanel()

    const recorded = COPY.workspace.approvedByActor('yaakovytroutai@gmail.com')
    await waitFor(() => {
      expect(screen.getByText(recorded)).toBeInTheDocument()
    })
    expect(screen.queryByText(COPY.workspace.approvedByActor(COPY.workspace.authorNotRecorded))).toBeNull()
    expect(screen.queryByText(COPY.workspace.approvedByActor('agent'))).toBeNull()
  })
})
