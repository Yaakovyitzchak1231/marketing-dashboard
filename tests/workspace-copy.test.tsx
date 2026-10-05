/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import { COPY } from '@/lib/copy'
import { SharedWorkspace } from '@/components/shared-workspace'

const FORBIDDEN = ['sync', 'collaboration', 'synergy', 'unlock', '!']

// Every static string on the workspace surface, derived from COPY so a new
// string cannot ship without this test noticing it is missing from the deck.
const WORKSPACE_STATIC_STRINGS = Object.values(COPY.workspace).flatMap((value) =>
  typeof value === 'string' ? [value] : [],
)

const firstRun = {
  ownerEmail: null,
  lastActor: null,
  shared: false,
  revisions: [] as const,
  approvals: [] as const,
  comments: [] as const,
  approvalNeeded: false,
}

describe('shared workspace copy', () => {
  it('keeps every static workspace string in the deck and in COPY', () => {
    const deck = readFileSync('docs/COPY_DECK.md', 'utf8')
    for (const sentence of WORKSPACE_STATIC_STRINGS) {
      expect(deck).toContain(sentence)
    }
    expect(deck).toContain('Saved by <actor or agent:build-data>')
    expect(deck).toContain('Owner: <email>')
    expect(deck).toContain('Last changed by <actor>')
    expect(deck).toContain('Request changes to <owner>')
    expect(deck).toContain('Comment on <row name>')
    expect(COPY.workspace.savedBy('agent:build-data')).toBe('Saved by agent:build-data')
    expect(COPY.workspace.owner('owner@example.com')).toBe('Owner: owner@example.com')
    expect(COPY.workspace.lastChangedBy('agent:build-data')).toBe(
      'Last changed by agent:build-data',
    )
    expect(COPY.workspace.requestChangesTo('owner@example.com')).toBe(
      'Request changes to owner@example.com',
    )
    expect(COPY.workspace.commentOn('Spring restock')).toBe('Comment on Spring restock')
    expect(COPY.workspace.approvedByActor('agent:build-qa')).toBe('Approved by agent:build-qa')
  })

  it('does not use hype, sync, or collaboration in the workspace strings', () => {
    const rendered = [
      ...WORKSPACE_STATIC_STRINGS,
      COPY.workspace.savedBy('agent:build-data'),
      COPY.workspace.owner('owner@example.com'),
      COPY.workspace.lastChangedBy('agent:build-data'),
      COPY.workspace.requestChangesTo('owner@example.com'),
      COPY.workspace.commentOn('Spring restock'),
      COPY.workspace.approvedByActor('agent:build-qa'),
      COPY.workspace.dismissedBy('agent:build-ui'),
    ]
    for (const sentence of rendered) {
      const lower = sentence.toLowerCase()
      for (const banned of FORBIDDEN) {
        expect(lower).not.toContain(banned)
      }
      expect(sentence).toMatch(/^[\x20-\x7E]+$/)
    }
  })

  it('renders first-run empty states and does not invent an author or a count', () => {
    render(<SharedWorkspace {...firstRun} />)
    expect(screen.getByRole('heading', { level: 1, name: COPY.workspace.title })).toBeTruthy()
    expect(screen.getByText(COPY.workspace.whatItIsBody)).toBeTruthy()
    expect(screen.getByText(COPY.workspace.whoBody)).toBeTruthy()
    expect(screen.getByText(COPY.workspace.costBody)).toBeTruthy()
    expect(screen.getByText(COPY.workspace.noRevisions)).toBeTruthy()
    expect(screen.getByText(COPY.workspace.noApprovals)).toBeTruthy()
    expect(screen.getByText(COPY.workspace.noApprovalNeeded)).toBeTruthy()
    expect(screen.getByText(COPY.workspace.noComments)).toBeTruthy()
    expect(screen.getByText(COPY.workspace.ownerNotRecorded)).toBeTruthy()
    expect(screen.getByText(COPY.workspace.boundaryTitle)).toBeTruthy()
    expect(screen.getByText(COPY.workspace.revisionsStayLocal)).toBeTruthy()
    expect(screen.getAllByText(COPY.workspace.localContext).length).toBeGreaterThan(0)
    expect(screen.queryByText(COPY.workspace.sharedWithAgents)).toBeNull()
    expect(screen.queryByText(/Saved by/)).toBeNull()
    expect(screen.queryByText(/Approved by/)).toBeNull()
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.queryByText('—')).toBeNull()
    expect(screen.getByTestId('workspace-boundary-badge')).toHaveAttribute('data-boundary', 'local')
  })

  it('says the load failed instead of pretending the lists are empty', () => {
    render(
      <SharedWorkspace
        {...firstRun}
        revisions={null}
        approvals={null}
        comments={null}
      />,
    )
    expect(screen.queryByText(COPY.workspace.noRevisions)).toBeNull()
    expect(screen.queryByText(COPY.workspace.noApprovals)).toBeNull()
    expect(screen.queryByText(COPY.workspace.noComments)).toBeNull()
    expect(screen.getAllByText(COPY.error).length).toBeGreaterThan(0)
  })

  it('renders a recorded revision and approval without a dangling approved', () => {
    render(
      <SharedWorkspace
        ownerEmail="owner@example.com"
        lastActor="agent:build-data"
        shared={false}
        approvalNeeded
        revisions={[
          {
            id: 'rev-1',
            actor: 'agent:build-data',
            kind: 'edit',
            message: 'Corrected the reply count',
            at: '2026-10-05T16:00:00Z',
          },
        ]}
        approvals={[
          {
            id: 'ap-1',
            status: 'approved',
            actor: 'agent:build-qa',
            owner: 'owner@example.com',
          },
          {
            id: 'ap-2',
            status: 'approved',
            actor: null,
            owner: 'owner@example.com',
          },
        ]}
        comments={[
          {
            id: 'c-1',
            actor: 'agent:build-copy',
            rowName: 'Spring restock',
            body: 'The rate line is the unreliable one.',
          },
        ]}
        onRestore={() => {}}
        onRequestChanges={() => {}}
        onApprove={() => {}}
      />,
    )
    expect(screen.getByText('Saved by agent:build-data')).toBeTruthy()
    expect(screen.getByText('Owner: owner@example.com')).toBeTruthy()
    expect(screen.getByText('Last changed by agent:build-data')).toBeTruthy()
    expect(screen.getByText('Approved by agent:build-qa')).toBeTruthy()
    expect(screen.getByText(COPY.workspace.authorNotRecorded)).toBeTruthy()
    expect(screen.queryByText('Approved by')).toBeNull()
    expect(screen.getByRole('button', { name: COPY.workspace.restoreThisVersion })).toBeTruthy()
    expect(screen.getByRole('button', { name: COPY.workspace.approve })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Request changes to owner@example.com' }),
    ).toBeTruthy()
    expect(screen.getByText('Comment on Spring restock')).toBeTruthy()
    expect(screen.queryByText(COPY.workspace.noRevisions)).toBeNull()
    expect(screen.queryByText(COPY.workspace.noApprovalNeeded)).toBeNull()
  })

  it('does not default the author in the component or the page', () => {
    const component = readFileSync('components/shared-workspace.tsx', 'utf8')
    const page = readFileSync('app/workspace/page.tsx', 'utf8')
    expect(component).not.toContain('agent:build-data')
    expect(page).not.toContain('agent:build-data')
    expect(page).toContain('shared={false}')
    expect(page).toContain('approvalNeeded={false}')
  })
})
