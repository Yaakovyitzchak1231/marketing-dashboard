// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import type { DashboardData } from '@/lib/dashboard/types'
import { Dashboard } from '@/components/dashboard/Dashboard'
import { bestStep, sortCampaigns } from '@/components/dashboard/CampaignTable'
import { AutoRefresh } from '@/components/ops/AutoRefresh'
import type { LiveChange } from '@/components/ops/live'
import { CampaignsSection, DailySection, KpiSection } from '@/components/dashboard/PerformanceView'
import type { DashboardSummary } from '@/lib/dashboard/load'
import { refreshCount } from './mock-navigation'

const live = vi.hoisted(() => ({ listener: null as ((c: LiveChange) => void) | null, connected: true }))
vi.mock('@/components/ops/live', () => ({
  subscribeLive: (l: (c: LiveChange) => void) => {
    live.listener = l
    return () => { live.listener = null }
  },
  liveConnected: () => live.connected,
}))

const fixture = (): DashboardData =>
  JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/dashboard.sample.json'), 'utf8'))

const EMPTY_COUNTS = {
  sent: null, contacted: null, opened: null, clicked: null, replied: null, autoReplies: null,
  bounced: null, unsubscribed: null, positive: null, meetingsBooked: null, opportunityValue: null,
}
const EMPTY_RATES = {
  replyRate: null, positiveRate: null, positiveShareOfReplies: null, bounceRate: null,
  openRate: null, clickRate: null, unsubscribeRate: null,
}

function notConfigured(): DashboardData {
  return {
    generatedAt: '2026-10-08T16:00:00Z',
    range: { key: '30d', start: '2026-09-09', end: '2026-10-08', timezone: 'America/New_York' },
    configured: false,
    totals: { counts: EMPTY_COUNTS, rates: EMPTY_RATES },
    previous: null,
    daily: [], campaigns: [], accounts: [], repliedLeads: [], insights: [], errors: [],
  }
}

describe('Dashboard', () => {
  it('renders the KPI band first, then the insights (the band carries no heading)', () => {
    const { container } = render(<Dashboard data={fixture()} />)
    const headings = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent)
    expect(headings[0]).toBe('What to do next')
    // The band comes before that heading in the DOM: numbers first, advice second.
    const band = container.querySelector('[aria-label="Key numbers"]')
    const first = container.querySelector('h2')
    expect(band && first ? band.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy()
    expect(screen.getByText('3 people replied and are waiting on you')).toBeInTheDocument()
    // severity order: critical before win
    const sev = Array.from(container.querySelectorAll('[data-severity]')).map((e) => e.getAttribute('data-severity'))
    expect(sev[0]).toBe('critical')
  })

  it('shows KPI rates from the data with one decimal and deltas vs the prior period', () => {
    render(<Dashboard data={fixture()} />)
    expect(within(screen.getByTestId('kpi-reply')).getByText('1.4%')).toBeInTheDocument()
    expect(within(screen.getByTestId('kpi-positive')).getByText('0.0%')).toBeInTheDocument()
    expect(within(screen.getByTestId('kpi-bounce')).getByText('0.2%')).toBeInTheDocument()
    expect(within(screen.getByTestId('kpi-sent')).getByText('2,618')).toBeInTheDocument()
    expect(within(screen.getByTestId('kpi-sent')).getByText(/17%/)).toBeInTheDocument()
  })

  it('says "tracking off" for opens instead of 0%', () => {
    render(<Dashboard data={fixture()} />)
    expect(screen.getAllByText('tracking off').length).toBeGreaterThan(0)
  })

  it('renders unreported values as a dash with a tooltip, never 0', () => {
    const data = fixture()
    data.totals.counts.meetingsBooked = null
    render(<Dashboard data={data} />)
    const cell = within(screen.getByTestId('kpi-meetings')).getByTitle('Not reported by Instantly')
    expect(cell.textContent).toBe('—')
  })

  it('folds campaigns with no sends in range, and reveals them on request', () => {
    render(<Dashboard data={fixture()} />)
    const table = screen.getByTestId('campaign-table')
    expect(within(table).queryByText('Campaign B — Signup follow-up')).toBeNull()
    fireEvent.click(screen.getAllByText(/with no sends in this range/)[0])
    expect(within(screen.getByTestId('campaign-table')).getByText('Campaign B — Signup follow-up')).toBeInTheDocument()
  })

  it('expands a campaign to per-step results with subject lines', () => {
    render(<Dashboard data={fixture()} />)
    const table = screen.getByTestId('campaign-table')
    fireEvent.click(within(table).getByRole('button', { name: /Campaign A/ }))
    // rendered twice: phone list + desktop table (CSS picks one)
    expect(within(table).getAllByText("Quick question about {{companyName}}'s online store").length).toBeGreaterThan(0)
    expect(within(table).getAllByText('best reply rate').length).toBeGreaterThan(0)
    expect(within(table).getAllByText('1.1%').length).toBeGreaterThan(0)
  })

  it('lists replies waiting on us, oldest first, with the snippet', () => {
    render(<Dashboard data={fixture()} />)
    const list = screen.getByTestId('waiting-list')
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Dana R.')
    expect(items[0]).toHaveTextContent('3 days waiting')
  })

  it('not configured: a setup card and no numbers at all', () => {
    const { container } = render(<Dashboard data={notConfigured()} />)
    expect(screen.getByTestId('not-configured')).toHaveTextContent('INSTANTLY_API_KEY')
    expect(container.textContent).not.toMatch(/\d+(\.\d)?%/)
    expect(screen.queryByTestId('kpi-sent')).toBeNull()
  })

  it('empty range: says so instead of drawing empty charts', () => {
    const data = { ...notConfigured(), configured: true }
    render(<Dashboard data={data} />)
    expect(screen.getByTestId('empty-range')).toHaveTextContent('No campaign activity in last 30 days')
  })

  it('partial errors are shown by name and can be dismissed', () => {
    const data = fixture()
    data.errors = [{ source: 'campaigns/analytics/steps', message: 'Instantly timed out' }]
    render(<Dashboard data={data} />)
    const notice = screen.getByTestId('errors-notice')
    expect(notice).toHaveTextContent('per-step results')
    expect(notice).toHaveTextContent('Instantly timed out')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('errors-notice')).toBeNull()
  })

  it('shows the sample banner only when asked', () => {
    const { rerender } = render(<Dashboard data={fixture()} />)
    expect(screen.queryByTestId('sample-banner')).toBeNull()
    rerender(<Dashboard data={fixture()} sample />)
    expect(screen.getByTestId('sample-banner')).toBeInTheDocument()
  })
})

describe('streamed sections', () => {
  function summaryFixture(trackingOff = false): DashboardSummary {
    const d = fixture()
    return {
      generatedAt: d.generatedAt,
      range: d.range,
      configured: true,
      totals: d.totals,
      previous: d.previous,
      trackingOff,
      errors: [],
      ctx: null,
    }
  }

  it('the KPI band renders from the fast summary alone, before any section has loaded', () => {
    render(<KpiSection summary={summaryFixture(true)} />)
    expect(within(screen.getByTestId('kpi-sent')).getByText('2,618')).toBeInTheDocument()
    expect(within(screen.getByTestId('kpi-reply')).getByText('1.4%')).toBeInTheDocument()
    expect(screen.getByText('tracking off')).toBeInTheDocument()
  })

  it('a section shows its own error next to itself, not a page-wide notice', () => {
    render(<CampaignsSection result={{ data: [], errors: [{ source: 'campaigns/analytics/steps', message: 'Instantly timed out' }] }} />)
    const notice = screen.getByTestId('errors-notice')
    expect(notice).toHaveTextContent('per-step results')
    expect(notice).toHaveTextContent('Instantly timed out')
  })

  it('a clean section shows no error notice, and an unreported chart says so', () => {
    render(<DailySection result={{ data: [], errors: [] }} />)
    expect(screen.queryByTestId('errors-notice')).toBeNull()
    expect(screen.getByText('No daily activity reported for this range.')).toBeInTheDocument()
  })
})

describe('campaign helpers', () => {
  it('sorting keeps unreported values last in both directions', () => {
    const rows = fixture().campaigns
    rows[1].rates.replyRate = 0.5
    const desc = sortCampaigns(rows, 'replyRate', 'desc')
    const asc = sortCampaigns(rows, 'replyRate', 'asc')
    expect(desc[0].rates.replyRate).toBe(0.5)
    expect(desc[desc.length - 1].rates.replyRate).toBeNull()
    expect(asc[asc.length - 1].rates.replyRate).toBeNull()
  })

  it('bestStep needs two eligible steps with enough sends', () => {
    const steps = fixture().campaigns[0].steps
    expect(bestStep(steps)?.variant).toBe('A')
    expect(bestStep(steps)?.step).toBe(1)
    expect(bestStep(steps.slice(0, 1))).toBeNull()
    expect(bestStep(steps.map((s) => ({ ...s, sent: 10 })))).toBeNull()
  })
})

describe('AutoRefresh on the campaign performance page', () => {
  const change = (last_reply_id: number | null, first = false): LiveChange => ({ unread: 0, last_event_id: 1, last_reply_id, first })
  afterEach(() => {
    vi.useRealTimers()
    live.connected = true
  })

  it('on="reply" re-reads only when a new reply is stored, never for other activity', () => {
    vi.useFakeTimers()
    render(<AutoRefresh on="reply" poll="always" seconds={300} />)
    act(() => live.listener!(change(7, true)))
    act(() => live.listener!(change(7)))
    act(() => { vi.advanceTimersByTime(5000) })
    expect(refreshCount()).toBe(0)
    act(() => live.listener!(change(8)))
    act(() => { vi.advanceTimersByTime(2000) })
    expect(refreshCount()).toBe(1)
  })

  it('a reply that lands while the stream reconnects still triggers a re-read', () => {
    vi.useFakeTimers()
    render(<AutoRefresh on="reply" poll="always" seconds={300} />)
    act(() => live.listener!(change(7, true)))
    act(() => live.listener!(change(9, true)))
    act(() => { vi.advanceTimersByTime(2000) })
    expect(refreshCount()).toBe(1)
  })

  it('poll="always" re-reads on the timer even with the stream connected; the default only as a fallback', () => {
    vi.useFakeTimers()
    const { unmount } = render(<AutoRefresh on="reply" poll="always" seconds={300} />)
    act(() => { vi.advanceTimersByTime(300_000) })
    expect(refreshCount()).toBe(1)
    unmount()
    render(<AutoRefresh seconds={30} />)
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(refreshCount()).toBe(1)
    live.connected = false
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(refreshCount()).toBe(2)
  })
})
