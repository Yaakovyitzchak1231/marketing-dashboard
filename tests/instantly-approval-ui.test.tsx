import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('server-only', () => ({}))
vi.mock('@/app/actions/instantly-approvals', () => ({ decideInstantlyApprovalAction: vi.fn() }))
vi.mock('next/link', () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }))

import { InstantlyApprovalCard } from '@/components/ops/InstantlyApprovalCard'
import type { GatePreview } from '@/lib/instantly/gate'

const preview: GatePreview = {
  instantly_action_id: 42,
  kind: 'add_leads',
  campaign_id: '0199aa11-2222-7333-8444-555566667777',
  campaign_name: 'Seg 1',
  reason: 'Segment 1 batch',
  ready_count: 2,
  excluded_count: 1,
  excluded_by_reason: { not_verified: 1 },
  sample: [
    { contact_id: 1, company_id: 10, company: 'Alpha Jewelers', name: 'Ann', email: 'ann@alpha.com' },
    { contact_id: 2, company_id: 11, company: 'Beta Gems', name: null, email: 'bo@beta.com' },
  ],
  instantly_checked: true,
  instantly_note: null,
  diff: [{ field: 'Leads in “Seg 1”', from: 'as now', to: '+2 (Instantly skips any already in the workspace)' }],
}

describe('Needs your OK: an agent’s Instantly request', () => {
  it('shows campaign, counts, the change, sample rows and who is left out', () => {
    render(<InstantlyApprovalCard approvalId={7} preview={preview} enabled />)
    const card = screen.getByTestId('instantly-approval')
    expect(card.textContent).toContain('Seg 1')
    expect(card.textContent).toContain('2 to add · 1 left out')
    expect(card.textContent).toContain('Why: Segment 1 batch')
    expect(card.textContent).toContain('+2 (Instantly skips any already in the workspace)')
    expect(card.textContent).toContain('Alpha Jewelers')
    expect(card.textContent).toContain('ann@alpha.com')
    expect(card.textContent).toContain('Left out: 1 email not verified yet')
    expect(screen.getByText('See every lead').getAttribute('href')).toBe('/leads/instantly?action=42')
  })

  it('Approve opens a confirm first; Reject needs a reason', () => {
    render(<InstantlyApprovalCard approvalId={7} preview={preview} enabled />)
    expect(screen.queryByText('Approve and send')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Approve: Add 2 to “Seg 1”' }))
    const group = screen.getByRole('group', { name: 'Confirm: Approve: Add 2 to “Seg 1”' })
    const hidden = Array.from(group.querySelectorAll('input[type=hidden]')).map((i) => [(i as HTMLInputElement).name, (i as HTMLInputElement).value])
    expect(hidden).toEqual([['approval_id', '7'], ['decision', 'approved'], ['confirm', 'yes']])
    const reason = screen.getByLabelText('Reason for rejecting') as HTMLInputElement
    expect(reason.required).toBe(true)
  })

  it('cannot approve when Instantly actions are off', () => {
    render(<InstantlyApprovalCard approvalId={7} preview={{ ...preview, kind: 'pause', diff: [{ field: 'Campaign status', from: 'active', to: 'paused' }] }} enabled={false} />)
    expect(screen.getByTitle('Instantly actions are off on this deploy').textContent).toBe('Approve: Pause “Seg 1”')
    expect(screen.getByText('active').className).toContain('line-through')
  })
})
