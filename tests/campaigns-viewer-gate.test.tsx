// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

/**
 * /campaigns is readable by viewers, but per the #97 view-only rule they get no
 * edit controls: no New campaign form, no Archive, no status Turn on/off or Add.
 * The server actions refuse viewers anyway (actorFor('editor')); this proves the
 * controls are not rendered in the first place.
 */
vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }))
vi.mock('@/lib/auth/session', () => ({ currentRole: vi.fn() }))
vi.mock('@/app/actions/campaigns', () => ({
  addStatusAction: vi.fn(),
  archiveCampaignAction: vi.fn(),
  createCampaignAction: vi.fn(),
  toggleStatusAction: vi.fn(),
}))
vi.mock('@/lib/pools/store', () => ({ listPools: async () => [{ id: 'jeweler', label: 'Jewelers' }] }))
vi.mock('@/lib/campaigns/store', () => ({
  listCampaigns: async () => [
    {
      id: 1, name: 'Maryland jewelers', goal: null, pool: 'jeweler', status: 'draft', status_label: 'Draft',
      status_archived: false, lead_count: 3, owner: 'owner', owner_name: 'Owner', updated_at: '2026-10-01T00:00:00Z', is_template: false,
    },
  ],
  listStatuses: async () => [
    { id: 'draft', label: 'Draft', active: true, is_archived: false },
    { id: 'warming', label: 'Warming up', active: true, is_archived: false },
  ],
}))

import { currentRole } from '@/lib/auth/session'
import CampaignsPage from '@/app/campaigns/page'

async function renderAs(role: 'viewer' | 'editor' | 'owner') {
  vi.mocked(currentRole).mockResolvedValue(role)
  render(await CampaignsPage({ searchParams: Promise.resolve({}) }))
}

afterEach(cleanup)

describe('/campaigns viewer gate', () => {
  it('a viewer sees campaigns and statuses but no edit controls', async () => {
    await renderAs('viewer')
    expect(screen.getByText('Maryland jewelers')).toBeTruthy()
    expect(screen.getByText('Warming up')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByText('New campaign')).toBeNull()
    expect(document.querySelectorAll('form').length).toBe(0)
  })

  it('an editor still gets New campaign, Archive and the status controls', async () => {
    await renderAs('editor')
    expect(screen.getByText('New campaign')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy()
  })
})
