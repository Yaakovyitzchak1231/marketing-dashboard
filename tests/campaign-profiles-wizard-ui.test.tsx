import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import './mock-navigation'
vi.mock('server-only', () => ({}))

vi.mock('@/app/actions/campaign-profiles', () => ({
  getProfileAction: vi.fn(async () => ({ ok: true, data: { profile: EMPTY_PROFILE, items: emptyItems(), exists: false } })),
  updateProfileAction: vi.fn(async () => ({ ok: true, data: EMPTY_PROFILE })),
  addProfileItemsAction: vi.fn(async () => ({ ok: true, added: [], already: [] })),
  setItemStatusAction: vi.fn(async () => ({ ok: true, items: [] })),
  updateProfileItemAction: vi.fn(async () => ({ ok: true, item: null })),
  suggestProfileAction: vi.fn(async () => ({ ok: true, result: { configured: false, reason: 'no AI provider is configured' } })),
  aiConfiguredAction: vi.fn(async () => ({ ok: true, configured: false })),
  verifyFeedAction: vi.fn(async () => ({ ok: true, result: { ok: true } })),
  copyProfileAction: vi.fn(async () => ({ ok: true, data: { profile: null, items_copied: 0 } })),
  approvedItemsAction: vi.fn(async () => ({ ok: true, items: [] })),
  listPoolsAction: vi.fn(async () => ({ ok: true, pools: [] })),
  createPoolAction: vi.fn(async () => ({ ok: true, pool: { id: 'x', label: 'X', description: null, sort: 100, active: true } })),
  recheckProfileItemAction: vi.fn(async () => ({ ok: true, item: null })),
}))

import { ProfileWizard } from '@/components/campaign-profiles/ProfileWizard'
import type { ItemKind, ProfileItem } from '@/lib/campaign-profiles/store'
import { ITEM_KINDS } from '@/lib/campaign-profiles/store'

const EMPTY_PROFILE = {
  campaign_id: 1, industry: null, vertical: null, description: null, icp: {}, value_prop: null, newsletter_list: null,
  utm: {}, kpis: [], setup_status: 'draft' as const, ai_last_suggested_at: null, ai_model: null,
  created_by: null, updated_by: null, created_at: new Date(), updated_at: new Date(),
}
function emptyItems(): Record<ItemKind, ProfileItem[]> {
  return Object.fromEntries(ITEM_KINDS.map((k) => [k, [] as ProfileItem[]])) as unknown as Record<ItemKind, ProfileItem[]>
}

function item(over: Partial<ProfileItem>): ProfileItem {
  return {
    id: 1, campaign_id: 1, kind: 'keyword', name: 'x', value: null, config: {}, status: 'approved', source: 'human',
    rationale: null, verify_status: 'not_applicable', verify_detail: null, verified_at: null, sort: 100,
    created_by: 'owner', updated_by: 'owner', created_at: new Date(), updated_at: new Date(), ...over,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Campaign profile wizard', () => {
  it('Step 1: renders industry/ICP fields for a fresh (draft) profile', () => {
    render(
      <ProfileWizard
        campaignId={1} campaignName="Dental Q4"
        initial={{ profile: EMPTY_PROFILE, items: emptyItems(), exists: false }}
        pools={[{ id: 'jeweler', label: 'Jewelers', description: null, sort: 10, active: true }]}
        aiConfigured={false}
      />,
    )
    expect(screen.getByText('What industry, and who do you sell to?')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Independent jewelers/)).toBeInTheDocument()
  })

  it('Step 2: shows the "AI suggestions need an AI provider" message when not configured', () => {
    render(
      <ProfileWizard
        campaignId={1} campaignName="Dental Q4"
        initial={{ profile: EMPTY_PROFILE, items: emptyItems(), exists: false }}
        pools={[]}
        aiConfigured={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /2\. Suggest with AI/ }))
    expect(screen.getByText(/AI suggestions need an AI provider — add one in Settings/)).toBeInTheDocument()
  })

  it('Step 2: when configured, shows suggested items grouped by kind with Approve/Reject and rationale', () => {
    const items = emptyItems()
    items.competitor = [item({ id: 10, kind: 'competitor', name: 'Toast', value: 'toasttab.com', status: 'suggested', source: 'ai', rationale: 'direct POS competitor', verify_status: 'ok', verify_detail: 'page loads' })]
    render(
      <ProfileWizard
        campaignId={1} campaignName="Restaurants"
        initial={{ profile: { ...EMPTY_PROFILE, industry: 'Restaurants' }, items, exists: true }}
        pools={[]}
        aiConfigured
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /2\. Suggest with AI/ }))
    expect(screen.getByText('Toast')).toBeInTheDocument()
    expect(screen.getByText('direct POS competitor')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
    expect(screen.getByText('checked')).toBeInTheDocument()
  })

  it('Step 3: renders approved items as chips, grouped by kind, with an add form', () => {
    const items = emptyItems()
    items.keyword = [item({ id: 1, kind: 'keyword', name: 'brunch menu', status: 'approved' })]
    render(
      <ProfileWizard
        campaignId={1} campaignName="Restaurants"
        initial={{ profile: { ...EMPTY_PROFILE, industry: 'Restaurants' }, items, exists: true }}
        pools={[]}
        aiConfigured={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /3\. Add & review items/ }))
    expect(screen.getByText('brunch menu')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('e.g. Toast')).toBeInTheDocument()
  })

  it('Step 4: renders UTM fields and KPI add form, and a Done button', () => {
    render(
      <ProfileWizard
        campaignId={1} campaignName="Restaurants"
        initial={{ profile: EMPTY_PROFILE, items: emptyItems(), exists: false }}
        pools={[]}
        aiConfigured={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /4\. UTM \+ KPIs/ }))
    expect(screen.getByText('utm_source')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Done — make it active/ })).toBeInTheDocument()
  })
})
