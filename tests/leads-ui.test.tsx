// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import React from 'react'
import { AppNav, NAV_ITEMS, isActive } from '@/components/nav/AppNav'
import { LeadsTable } from '@/components/leads/LeadsTable'
import { KanbanBoard, CampaignGroups, RegionGroups, ViewTabs, Pagination, FilterBar } from '@/components/leads/LeadViews'
import { PageShell, DbNotConnected } from '@/components/app/PageShell'
import { parseLeadQuery } from '@/lib/leads/filters'
import type { LeadListRow, KanbanColumn, LeadGroup } from '@/lib/leads/queries'
import { STAGES } from '@/lib/leads/types'

const { pathname } = vi.hoisted(() => ({ pathname: { value: '/' } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname.value,
  useSearchParams: () => new URLSearchParams(),
}))

function row(id: number, over: Partial<LeadListRow> = {}): LeadListRow {
  return {
    id, name: `Store ${id}`, segment: 'jeweler', website: null, website_domain: `s${id}.com`, city: 'Baltimore', state: 'MD',
    owner_name: null, stage: 'new', research_status: 'needs_research', updated_at: new Date('2026-10-08T12:00:00Z'),
    primary_contact_id: null, primary_email: null, primary_verification: null, contact_count: 0, unverified_ids: [],
    campaign_name: null, last_event_type: null, last_event_at: null, ...over,
  }
}
const q = (s = '') => parseLeadQuery(Object.fromEntries(new URLSearchParams(s)))

describe('AppNav', () => {
  it('lists every screen and marks the active one (sub-pages included)', () => {
    pathname.value = '/leads/12'
    render(<AppNav />)
    const nav = screen.getByRole('navigation', { name: 'Screens' })
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(NAV_ITEMS.map((i) => i.label))
    expect(within(nav).getByRole('link', { name: 'Leads' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
    expect(isActive('/', '/')).toBe(true)
    expect(isActive('/leads', '/')).toBe(false)
  })

  it('stays off the login page', () => {
    pathname.value = '/login'
    const { container } = render(<AppNav />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('PageShell', () => {
  it('renders a title, meta and the honest not-connected state', () => {
    render(<PageShell title="Leads" meta="no rows"><DbNotConnected what="The Leads screen" /></PageShell>)
    expect(screen.getByRole('heading', { level: 1, name: 'Leads' })).toBeInTheDocument()
    expect(screen.getByTestId('db-not-connected')).toHaveTextContent('DATABASE_URL')
  })
})

describe('LeadsTable', () => {
  const rows = [
    row(1, { primary_email: 'a@s1.com', primary_verification: 'unverified', unverified_ids: [11, 12], contact_count: 2 }),
    row(2, { primary_email: 'b@s2.com', primary_verification: 'valid', stage: 'ready' }),
  ]
  const props = { rows, sortLinks: [{ key: 'name' as const, href: '/leads?sort=name', dir: 'asc' as const }], updatedLabels: { 1: 'Oct 8', 2: 'Oct 7' } }

  it('shows no bulk bar until something is selected, then offers research, verify and set stage', () => {
    render(<LeadsTable {...props} />)
    expect(screen.queryByRole('region', { name: 'Selected leads' })).toBeNull()
    const table = screen.getByTestId('leads-table')
    fireEvent.click(within(table).getByLabelText('Select Store 1'))
    const bar = screen.getByRole('region', { name: 'Selected leads' })
    expect(bar).toHaveTextContent('1 selected')
    expect(within(bar).getByRole('link', { name: /Verify selected/ })).toHaveAttribute('href', '/verify?ids=11%2C12')
    expect(within(bar).getByRole('button', { name: 'Research selected' })).toBeEnabled()
    expect(within(bar).getByRole('button', { name: 'Apply' })).toBeDisabled()
  })

  it('select-all picks the page; selecting only verified leads disables Verify', () => {
    render(<LeadsTable {...props} />)
    const table = screen.getByTestId('leads-table')
    fireEvent.click(within(table).getByLabelText('Select Store 2'))
    expect(screen.getByRole('region', { name: 'Selected leads' })).toHaveTextContent('Verify selected')
    fireEvent.click(within(table).getByLabelText('Select all on this page'))
    expect(screen.getByRole('region', { name: 'Selected leads' })).toHaveTextContent('2 selected')
  })

  it('marks the sorted column and shows null as a dash, never zero', () => {
    render(<LeadsTable {...props} rows={[row(3)]} />)
    const table = screen.getByTestId('leads-table')
    expect(within(table).getByRole('columnheader', { name: /Lead/ })).toHaveAttribute('aria-sort', 'ascending')
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0)
  })

  it('posts "Research selected" to the research queue and says what happened', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ queued: 1 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<LeadsTable {...props} />)
    fireEvent.click(within(screen.getByTestId('leads-table')).getByLabelText('Select Store 1'))
    fireEvent.click(screen.getByRole('button', { name: 'Research selected' }))
    expect(await screen.findByRole('status')).toHaveTextContent('1 queued for research.')
    expect(fetchMock).toHaveBeenCalledWith('/api/research/enqueue', expect.objectContaining({ method: 'POST', body: JSON.stringify({ company_ids: [1] }) }))
    vi.unstubAllGlobals()
  })
})

describe('Lead views', () => {
  it('view tabs link each view and keep filters', () => {
    render(<ViewTabs q={q('view=kanban&state=MD')} />)
    expect(screen.getByRole('link', { name: 'By stage' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Needs verification' })).toHaveAttribute('href', '/leads?view=verify&state=MD')
    expect(screen.getByRole('link', { name: 'Table' })).toHaveAttribute('href', '/leads?state=MD')
  })

  it('filter bar is a plain GET form carrying the current view', () => {
    const { container } = render(<FilterBar q={q('view=research&state=MD')} states={['MD', 'PA']} campaigns={[]} />)
    const form = container.querySelector('form')!
    expect(form).toHaveAttribute('method', 'get')
    expect(form.querySelector('input[name=view]')).toHaveValue('research')
    expect(screen.getByLabelText('State')).toHaveValue('MD')
  })

  it('kanban: a column per stage with its count, cards with a stage menu, and a link to the rest', () => {
    const cols: KanbanColumn[] = STAGES.map((s) => ({ stage: s, label: s, count: s === 'new' ? 40 : 0, cards: s === 'new' ? [row(1)] : [] }))
    render(<KanbanBoard q={q('view=kanban')} columns={cols} />)
    const col = screen.getByRole('region', { name: 'new' })
    expect(col).toHaveTextContent('40')
    expect(within(col).getByLabelText('Stage for Store 1')).toHaveValue('new')
    expect(within(col).getByRole('link', { name: 'All 40 in new' })).toHaveAttribute('href', '/leads?stage=new')
  })

  it('campaign groups: names, totals linking to the filtered table, "No campaign yet" last', () => {
    const groups: LeadGroup[] = [
      { key: 'Jewelers Q4', total: 3, byStage: { in_campaign: 2, replied: 1 }, unverified: 0, sample: [row(1)] },
      { key: null, total: 9, byStage: { new: 9 }, unverified: 4, sample: [] },
    ]
    render(<CampaignGroups q={q('view=campaign')} groups={groups} />)
    expect(screen.getByRole('link', { name: '3 leads' })).toHaveAttribute('href', '/leads?campaign=Jewelers+Q4')
    expect(screen.getByText('No campaign yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '9 leads' })).toHaveAttribute('href', '/leads?campaign=__none')
  })

  it('region table: states link to the filtered table, stage cells to state+stage', () => {
    const groups: LeadGroup[] = [{ key: 'MD', total: 2, byStage: { new: 1, ready: 1 }, unverified: 1, sample: [] }]
    render(<RegionGroups q={q('view=region')} groups={groups} />)
    expect(screen.getByRole('link', { name: 'MD' })).toHaveAttribute('href', '/leads?state=MD')
    const cells = within(screen.getByTestId('region-table')).getAllByRole('link', { name: '1' })
    expect(cells.map((c) => c.getAttribute('href'))).toEqual(['/leads?state=MD&stage=new', '/leads?state=MD&stage=ready'])
  })

  it('pagination states the range from the counts', () => {
    render(<Pagination q={q('page=2')} page={{ rows: [], total: 120, page: 2, pageSize: 50, pages: 3 }} />)
    expect(screen.getByTestId('page-range')).toHaveTextContent('51–100 of 120')
    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute('href', '/leads')
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute('href', '/leads?page=3')
  })
})
