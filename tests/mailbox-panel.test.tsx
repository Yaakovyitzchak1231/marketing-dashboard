/**
 * TAP-114: the "Emails with you" panel's states, rendered from the pure view.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'

vi.mock('server-only', () => ({}))
const { role, read } = vi.hoisted(() => ({ role: { value: 'owner' as string | null }, read: { calls: 0 } }))
vi.mock('@/lib/auth/session', () => ({ currentActorId: async () => 'owner', currentRole: async () => role.value }))
vi.mock('@/lib/mailbox/server', () => ({
  leadMailbox: async () => {
    read.calls++
    return { state: 'off' }
  },
}))

import { MailboxEmails, MailboxEmailsView } from '@/components/leads/MailboxEmails'

afterEach(cleanup)

const msg = (id: string, direction: 'sent' | 'received', subject: string) => ({
  provider: 'outlook' as const,
  id,
  direction,
  subject,
  at: '2026-10-13T15:11:52Z',
  from: direction === 'sent' ? 'owner@example.co' : 'jane@lead.io',
  to: [],
  cc: [],
  preview: `preview ${id}`,
  webLink: direction === 'sent' ? 'https://outlook.office365.com/owa/?ItemID=1' : null,
  conversationId: null,
  matched: 'jane@lead.io',
})

describe('MailboxEmails', () => {
  it('renders nothing while the flag is off', async () => {
    role.value = 'owner'
    const el = await MailboxEmails({ addresses: ['jane@lead.io'], companyId: 7 })
    expect(el).toBeNull()
  })

  it('shows the owner’s mail to the owner only, and reads nothing for anyone else', async () => {
    for (const r of ['editor', 'viewer', null]) {
      role.value = r
      read.calls = 0
      expect(await MailboxEmails({ addresses: ['jane@lead.io'], companyId: 7 })).toBeNull()
      expect(read.calls).toBe(0)
    }
    role.value = 'owner'
    read.calls = 0
    await MailboxEmails({ addresses: ['jane@lead.io'], companyId: 7 })
    expect(read.calls).toBe(1)
  })

  it('tells the owner what is missing, and offers Connect when not connected', () => {
    render(<MailboxEmailsView state={{ state: 'not_configured', missing: ['Microsoft app (client) ID'] }} isOwner next="/leads/7?tab=timeline" />)
    expect(screen.getByText(/Add the Microsoft app \(client\) ID in Settings → Mailboxes/)).toBeTruthy()
    cleanup()
    render(<MailboxEmailsView state={{ state: 'not_connected' }} isOwner next="/leads/7?tab=timeline" />)
    const a = screen.getByRole('link', { name: 'Connect Outlook' })
    expect(a.getAttribute('href')).toBe('/api/mailbox/outlook/connect?next=%2Fleads%2F7%3Ftab%3Dtimeline')
    cleanup()
    render(<MailboxEmailsView state={{ state: 'not_connected' }} isOwner={false} next="/leads/7" />)
    expect(screen.queryByRole('link', { name: 'Connect Outlook' })).toBeNull()
  })

  it('lists sent and received mail with direction and an Outlook link', () => {
    render(
      <MailboxEmailsView
        state={{
          state: 'read',
          addresses: ['jane@lead.io'],
          truncated: false,
          messages: [msg('a', 'sent', 'RE: pricing'), msg('b', 'received', 'pricing')],
          results: [{ provider: 'outlook', label: 'Outlook', address: 'owner@example.co', status: 'ok', messages: [], truncated: false }],
        }}
        isOwner
        next="/leads/7"
      />,
    )
    expect(screen.getByText('Emails with you')).toBeTruthy()
    expect(screen.getByText('2 · owner@example.co')).toBeTruthy()
    expect(screen.getByText('You wrote')).toBeTruthy()
    expect(screen.getByText('They wrote')).toBeTruthy()
    expect(screen.getByText('to jane@lead.io', { exact: false })).toBeTruthy()
    expect(screen.getByText('from jane@lead.io')).toBeTruthy()
    expect(screen.getAllByRole('link', { name: 'Open in Outlook' })).toHaveLength(1)
  })

  it('says so plainly when nothing matched, and shows a read error verbatim', () => {
    render(
      <MailboxEmailsView
        state={{
          state: 'read',
          addresses: ['jane@lead.io'],
          truncated: false,
          messages: [],
          results: [{ provider: 'outlook', label: 'Outlook', address: 'owner@example.co', status: 'ok', messages: [], truncated: false }],
        }}
        isOwner
        next="/leads/7"
      />,
    )
    expect(screen.getByText('No 1:1 emails with jane@lead.io in owner@example.co.')).toBeTruthy()
    cleanup()
    render(
      <MailboxEmailsView
        state={{ state: 'read', addresses: ['jane@lead.io'], truncated: false, messages: [], results: [{ provider: 'outlook', label: 'Outlook', address: 'owner@example.co', status: 'error', error: 'Outlook answered HTTP 401: Access token has expired.' }] }}
        isOwner
        next="/leads/7"
      />,
    )
    expect(screen.getByText(/Couldn’t read Outlook \(owner@example.co\): Outlook answered HTTP 401: Access token has expired./)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Reconnect' })).toBeTruthy()
  })
})
