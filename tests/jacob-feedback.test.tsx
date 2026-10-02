/**
 * @vitest-environment jsdom
 *
 * Jacob's three in-app comments, reproduced against the figures the live page
 * actually serves.
 *
 * The live aria-label read "3 days of data, from 31,893 to 31,893, changing by
 * +0", so the flat series below is the production shape, not a synthetic edge
 * case. Each test names the comment it answers.
 */

import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { TrendChartArea, type TrendPoint } from '@/components/trend-chart'
import { KpiRow, type Kpi } from '@/components/kpi-row'
import { CampaignTable, type CampaignRow } from '@/components/campaign-table'

const LIVE_FLAT: TrendPoint[] = [
  { day: '2026-08-31', value: 31893 },
  { day: '2026-09-15', value: 31893 },
  { day: '2026-09-30', value: 31893 },
]

const KPIS: Kpi[] = [
  { key: 'emails_sent', label: 'Emails sent', value: 31893, kind: 'count' },
  { key: 'replies_human', label: 'Replies (human)', value: 1357, kind: 'count' },
  { key: 'reply_rate', label: 'Reply rate', value: 0.0426, kind: 'rate' },
  { key: 'open_rate', label: 'Open rate', value: null, kind: 'rate' },
]

const ROW: CampaignRow[] = [
  {
    id: 'c1',
    name: 'PB Signups / Leads',
    status: 'active',
    emails_sent: 31893,
    replies_human: 1357,
    replies_autoresponder: 10,
    bounces: 120,
    opportunities: 22,
    reply_rate: 0.0426,
    bounce_rate: 0.0038,
    open_rate: null,
    unsubscribe: null,
    metric_date: '2026-09-30',
  },
]

describe("Jacob's comment 1: the useless On/Off boxes", () => {
  it('renders no toggle controls at all', () => {
    const { container } = render(<KpiRow kpis={KPIS} />)
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(screen.queryByLabelText('Filter metrics')).not.toBeInTheDocument()
    expect(screen.queryByText('Choose the signals shown below.')).not.toBeInTheDocument()
  })

  it('still shows every metric, including the ones with no value', () => {
    // Hiding a metric is hiding a gap. Open rate is unreported and must stay
    // visible as a dash.
    render(<KpiRow kpis={KPIS} />)
    for (const kpi of KPIS) {
      expect(screen.getByTestId(`kpi-${kpi.key}`)).toBeInTheDocument()
    }
    expect(within(screen.getByTestId('kpi-open_rate')).getByText('—')).toBeInTheDocument()
  })
})

describe("Jacob's comment 2: the useless flat graph", () => {
  it('says the series is a running total instead of implying sending stopped', () => {
    render(<TrendChartArea series={LIVE_FLAT} label="Emails sent" />)
    expect(screen.getByTestId('trend-cumulative-note')).toHaveTextContent(/running total/i)
    expect(screen.getByText('Emails sent (running total)')).toBeInTheDocument()
  })

  it('drops the meaningless "+0 vs first day" delta', () => {
    render(<TrendChartArea series={LIVE_FLAT} label="Emails sent" />)
    expect(screen.queryByText(/vs first day/)).not.toBeInTheDocument()
  })

  it('shows the real figures in a readable format, not just a stroke', () => {
    render(<TrendChartArea series={LIVE_FLAT} label="Emails sent" />)
    const table = screen.getByTestId('trend-breakdown')
    for (const point of LIVE_FLAT) {
      expect(within(table).getByText(point.day)).toBeInTheDocument()
    }
    // One printed figure per day -- all three days, not just the endpoints.
    expect(within(table).getAllByText('31,893')).toHaveLength(LIVE_FLAT.length)
  })

  it('does not stack three gridlines on one flat line', () => {
    const { container } = render(<TrendChartArea series={LIVE_FLAT} label="Emails sent" />)
    expect(container.querySelectorAll('svg line')).toHaveLength(1)
  })

  it('does not print the same axis figure twice', () => {
    const { container } = render(<TrendChartArea series={LIVE_FLAT} label="Emails sent" />)
    // One label, not "31,893" over the left and the right of the same value.
    expect(container.querySelectorAll('.absolute span')).toHaveLength(1)
  })

  it('describes the flat series honestly for a screen reader', () => {
    const { container } = render(<TrendChartArea series={LIVE_FLAT} label="Emails sent" />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('aria-label', expect.stringContaining('31,893'))
  })

  it('still draws a normal grid when the data genuinely varies', () => {
    const varied: TrendPoint[] = [
      { day: '2026-09-28', value: 100 },
      { day: '2026-09-29', value: 140 },
      { day: '2026-09-30', value: 120 },
    ]
    const { container } = render(<TrendChartArea series={varied} label="Emails sent" />)
    expect(container.querySelectorAll('svg line')).toHaveLength(3)
    expect(screen.queryByTestId('trend-cumulative-note')).not.toBeInTheDocument()
  })
})

describe("Jacob's comment 3: the redundant +10 autoresponder", () => {
  it('does not render a "+N" chip beside the human reply count', () => {
    render(<CampaignTable rows={ROW} />)
    expect(screen.queryByTestId('replies-auto-c1')).not.toBeInTheDocument()
    const human = screen.getByTestId('replies-human-c1')
    expect(human).toHaveTextContent('1,357')
    expect(human.textContent).not.toContain('10')
  })

  it('keeps the autoresponder figure in the Auto column, so nothing is lost', () => {
    render(<CampaignTable rows={ROW} />)
    expect(screen.getByTestId('replies-auto-cell-c1')).toHaveTextContent('10')
  })

  it('prints the autoresponder count exactly once in the row', () => {
    const { container } = render(<CampaignTable rows={ROW} />)
    const row = container.querySelector('li')
    // "10" must not appear as both a chip and a column value.
    expect(within(row as HTMLElement).getAllByText(/10/).length).toBeLessThanOrEqual(2)
  })
})