import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { deliverabilityInsights } from '@/lib/insights/accounts'
import { AccountsTable } from '@/components/dashboard/AccountsTable'
import type { SenderAccount } from '@/lib/dashboard/types'
import { account, input } from '../fixtures/insights/builders'

const ACTIVE = [{ id: 'c1', name: 'Jewelers', status: 'active' as const }]
const OLD = [{ id: 'c9', name: 'Old campaign', status: 'completed' as const }]
const on = (a: SenderAccount, campaigns: SenderAccount['campaigns']): SenderAccount => ({
  ...a,
  campaigns,
  inActiveCampaign: campaigns == null ? null : campaigns.some((c) => c.status === 'active'),
})

describe('errored inboxes vs active campaigns', () => {
  it('errors on inboxes no active campaign uses become one cleanup card, not critical', () => {
    const r = deliverabilityInsights(input({
      accounts: [
        on(account('live@x.com', { sent: 200, bounced: 0, warmupScore: 100 }), ACTIVE),
        on(account('old1@y.com', { status: 'connection error', sent: 0 }), OLD),
        on(account('old2@y.com', { status: 'connection error', sent: 0 }), []),
      ],
    }))
    expect(r.find((i) => i.id.startsWith('account-error:') || i.id === 'account-error')).toBeUndefined()
    const c = r.find((i) => i.id === 'account-error-unused')!
    expect(c.severity).toBe('opportunity')
    expect(c.title).toBe('2 inboxes have errors, but no active campaign uses them')
    expect(c.detail).toContain('only on Old campaign (completed)')
    expect(c.detail).toContain('on no campaign')
  })

  it('an errored inbox on an active campaign stays critical', () => {
    const r = deliverabilityInsights(input({
      accounts: [on(account('live@x.com', { status: 'connection error' }), ACTIVE)],
    }))
    expect(r.find((i) => i.id === 'account-error:live@x.com')!.severity).toBe('critical')
  })

  it('unknown campaign membership (null) keeps the old critical behaviour', () => {
    const r = deliverabilityInsights(input({ accounts: [on(account('a@x.com', { status: 'connection error' }), null)] }))
    expect(r.find((i) => i.id === 'account-error:a@x.com')!.severity).toBe('critical')
  })

  it('warmed inboxes on no active campaign are called out as spare capacity', () => {
    const r = deliverabilityInsights(input({
      accounts: [
        on(account('live@x.com', { sent: 200, bounced: 0, warmupScore: 100 }), ACTIVE),
        on(account('ai1@z.com', { sent: 0, warmupScore: 100 }), []),
        on(account('ai2@z.com', { sent: 0, warmupScore: 100 }), []),
      ],
    }))
    const c = r.find((i) => i.id === 'accounts-spare')!
    expect(c.title).toBe('2 warmed-up inboxes are not on any active campaign')
    expect(r.find((i) => i.id === 'accounts-idle')).toBeUndefined()
  })
})

describe('AccountsTable folds unused inboxes', () => {
  it('shows active-campaign inboxes and hides the rest behind a disclosure', () => {
    const accts: SenderAccount[] = [
      { ...on(account('live@x.com', { sent: 200 }), ACTIVE), health: 'healthy', healthReason: 'ok' },
      { ...on(account('old@y.com', { status: 'connection error' }), OLD), health: 'at_risk', healthReason: 'error' },
    ]
    render(<AccountsTable accounts={accts} />)
    expect(screen.getByText(/1 on active campaigns/)).toBeTruthy()
    const d = screen.getByTestId('unused-accounts')
    expect(d.textContent).toContain('Show 1 inbox not on any active campaign (1 with errors)')
  })
})

describe('warmup findings on unused inboxes', () => {
  it('are not raised as cards', () => {
    const r = deliverabilityInsights(input({
      accounts: [
        on(account('live@x.com', { sent: 200, bounced: 0, warmupScore: 100 }), ACTIVE),
        on(account('old@y.com', { sent: 0, warmupScore: 10 }), OLD),
      ],
    }))
    expect(r.find((i) => i.id.startsWith('warmup-'))).toBeUndefined()
  })
})
