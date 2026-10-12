// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'

vi.mock('server-only', () => ({}))
vi.mock('@/app/actions/edit', () => ({ updateEntityAction: vi.fn(), entityHistoryAction: vi.fn(), askToChangeAction: vi.fn() }))
const { role } = vi.hoisted(() => ({ role: { value: 'editor' as 'viewer' | 'editor' | 'owner' | null } }))
vi.mock('@/components/auth/useRole', async (orig) => ({
  ...(await orig<typeof import('@/components/auth/useRole')>()),
  useRole: () => role.value,
  fetchRole: async () => role.value,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }))

import { BulkBar } from '@/components/leads/BulkBar'
import { EngagementPanel } from '@/components/leads/EngagementPanel'
import { askToChangeAction } from '@/app/actions/edit'
import { VIEW_ONLY_EVENT } from '@/components/auth/viewOnly'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.mocked(askToChangeAction).mockReset()
})

describe('BulkBar: Edit field', () => {
  it('sends one request for all selected leads and shows the plain-words result', async () => {
    role.value = 'editor'
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) =>
      String(url).includes('bulk-edit')
        ? json({ field: 'city', updated: 2, unchanged: 1, failed: [], message: 'City: 2 updated, 1 unchanged.' })
        : json({ lists: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const done = vi.fn()
    render(<BulkBar selected={{ companyIds: [1, 2, 3], unverifiedContactIds: [] }} onDone={done} />)
    const select = screen.getByLabelText('Edit field') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['', 'website', 'phone', 'city', 'state'])
    fireEvent.change(select, { target: { value: 'city' } })
    fireEvent.change(screen.getByLabelText('New value'), { target: { value: 'Towson' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 3' }))
    // Apply only asks: the confirm shows the count, nothing is sent yet.
    expect(screen.getByRole('group', { name: 'Confirm bulk edit' })).toHaveTextContent('Set City to \u201CTowson\u201D on 3 leads?')
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('bulk-edit'))).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(done).toHaveBeenCalled())
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('bulk-edit'))!
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ company_ids: [1, 2, 3], field: 'city', value: 'Towson', confirm: true })
    expect((call[1] as RequestInit).method).toBe('PATCH')
  })

  it('Cancel sends nothing; an empty value asks to clear', () => {
    role.value = 'editor'
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => json({ lists: [] }))
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkBar selected={{ companyIds: [4], unverifiedContactIds: [] }} onDone={() => {}} />)
    fireEvent.change(screen.getByLabelText('Edit field'), { target: { value: 'phone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 1' }))
    expect(screen.getByRole('group', { name: 'Confirm bulk edit' })).toHaveTextContent('Clear Phone on 1 lead?')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Confirm bulk edit' })).toBeNull()
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('bulk-edit'))).toHaveLength(0)
  })

  it('a viewer gets the view-only note and nothing is sent', () => {
    role.value = 'viewer'
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => json({ lists: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const heard = vi.fn()
    window.addEventListener(VIEW_ONLY_EVENT, heard)
    render(<BulkBar selected={{ companyIds: [1], unverifiedContactIds: [] }} onDone={() => {}} />)
    const apply = screen.getByRole('button', { name: 'Apply to 1' })
    expect(apply).toHaveAttribute('aria-disabled', 'true')
    expect(apply).not.toBeDisabled()
    fireEvent.click(apply)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('group', { name: 'Confirm bulk edit' })).toBeNull()
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('bulk-edit'))).toHaveLength(0)
    window.removeEventListener(VIEW_ONLY_EVENT, heard)
  })
})

const data = {
  available: true,
  benchmarks: [{ campaign_id: 9, campaign_name: 'Spring', lead: { opens: 1, replies: 0, steps: 2 }, campaign_average: { opens: 0.5, replies: 0, steps: 2 } }],
}

describe('Engagement: Instantly numbers are read-only, with Ask to change', () => {
  it('shows the stored numbers with no inline editor, and files a request', async () => {
    role.value = 'editor'
    vi.mocked(askToChangeAction).mockResolvedValue({ ok: true, approvalId: 4, current: 1 })
    render(<EngagementPanel data={data} companyId={7} />)
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ask to change Opens' }))
    fireEvent.change(screen.getByLabelText('Should read'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'privacy pre-fetch' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send for OK' }))
    await waitFor(() => expect(askToChangeAction).toHaveBeenCalledWith({ companyId: 7, campaignId: 9, field: 'opens', proposed: '0', reason: 'privacy pre-fetch' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Asked. It is waiting in Needs your OK on Activity; Opens still reads 1')
  })

  it('a viewer never gets the form', () => {
    role.value = 'viewer'
    render(<EngagementPanel data={data} companyId={7} />)
    const b = screen.getByRole('button', { name: 'Ask to change Opens (view-only)' })
    fireEvent.click(b)
    expect(screen.queryByLabelText('Should read')).toBeNull()
    expect(askToChangeAction).not.toHaveBeenCalled()
  })

  it('without a companyId (e.g. elsewhere) renders no request control', () => {
    render(<EngagementPanel data={data} />)
    expect(screen.queryByText('Ask to change')).toBeNull()
  })
})
