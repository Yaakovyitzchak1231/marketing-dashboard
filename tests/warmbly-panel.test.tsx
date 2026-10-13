// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'
import { WarmblyPanel } from '@/components/tools/WarmblyPanel'
import type { WarmblySnapshot } from '@/lib/warmbly/snapshot'

const snap = (over: Partial<WarmblySnapshot> = {}): WarmblySnapshot => ({
  readAt: '2026-10-13T16:40:00Z',
  me: { ok: true, value: { organization: 'TapDash', scopes: ['read_emails'] } },
  mailboxes: { ok: true, value: { total: 0, rows: [], truncated: false } },
  campaigns: { ok: true, value: { total: 0, rows: [], truncated: false } },
  warmup: { ok: true, value: { from: '2026-09-29', to: '2026-10-13', sent: 0, replied: 0, replyRate: 0, daysActive: 0 } },
  allowance: { ok: true, value: { used: 0, allowance: null, remaining: null, basis: 'unlimited' } },
  ...over,
})

describe('WarmblyPanel (TAP-118)', () => {
  it('without a key says how to connect, and shows no numbers', () => {
    render(<WarmblyPanel view={{ state: 'no_key', baseUrl: 'https://w.example' }} />)
    expect(screen.getByText(/Not connected/)).toBeInTheDocument()
    expect(screen.queryByText('Mailboxes')).not.toBeInTheDocument()
  })

  it('an empty Warmbly shows real zeros and plain empty states', () => {
    render(<WarmblyPanel view={{ state: 'ready', baseUrl: 'https://w.example', keySource: 'env', snapshot: snap() }} />)
    expect(screen.getByText(/Live from Warmbly · TapDash/)).toBeInTheDocument()
    expect(screen.getByText(/No mailboxes connected in Warmbly yet/)).toBeInTheDocument()
    expect(screen.getByText(/No campaigns in Warmbly yet/)).toBeInTheDocument()
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(4)
  })

  it('lists mailboxes with warm-up and DNS state, and unreported fields as a dash', () => {
    const s = snap({
      mailboxes: {
        ok: true,
        value: {
          total: 1,
          truncated: false,
          rows: [{ id: 'm1', email: 'yaakov@tapdash.co', provider: 'google', status: 'active', warmup: 'paused', spf: 'pass', dkim: 'fail', dmarc: null, sending: null, sendingReason: null, risk: null, lastSyncedAt: null }],
        },
      },
    })
    render(<WarmblyPanel view={{ state: 'ready', baseUrl: 'https://w.example', keySource: 'db', snapshot: s }} />)
    expect(screen.getByText('yaakov@tapdash.co')).toBeInTheDocument()
    expect(screen.getByText('Paused')).toBeInTheDocument()
    expect(screen.getByText('SPF pass')).toBeInTheDocument()
    expect(screen.getByText('DKIM fail')).toBeInTheDocument()
    expect(screen.getAllByLabelText('Not reported by Warmbly').length).toBeGreaterThan(0)
  })

  it('a failed part shows its error in words', () => {
    const s = snap({ campaigns: { ok: false, status: 403, error: 'Warmbly answered 403: insufficient API key permissions' } })
    render(<WarmblyPanel view={{ state: 'ready', baseUrl: 'https://w.example', keySource: 'env', snapshot: s }} />)
    expect(screen.getByText(/Couldn.t read campaigns: Warmbly answered 403/)).toBeInTheDocument()
  })
})
