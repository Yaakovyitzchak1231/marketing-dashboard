import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { KpiRow, type Kpi } from '@/components/kpi-row'
import { CampaignTable, type CampaignRow } from '@/components/campaign-table'
import { SenderHealthPanel, type SenderHealth } from '@/components/sender-health'
import { TrendChartArea, type TrendPoint } from '@/components/trend-chart'
import { FreshnessIndicator } from '@/components/freshness'

/**
 * These tests pin the honesty rules the dashboard is judged on. Each one
 * corresponds to a bug from the old prototype that must not come back:
 * a null rendering as 0.0%, a rate above 100% being shown as a real result,
 * and a dashboard that invents a number to fill a gap.
 */

const kpis: Kpi[] = [
  { key: 'emails_sent', label: 'Emails sent', value: 31893, kind: 'count' },
  { key: 'reply_rate', label: 'Reply rate', value: 0.05, kind: 'rate' },
  { key: 'open_rate', label: 'Open rate', value: null, kind: 'rate' },
  { key: 'bounce_rate', label: 'Bounce rate', value: null, kind: 'rate' },
  { key: 'opportunity_value', label: 'Opportunity value', value: 125000, kind: 'currency' },
]

describe('KpiRow', () => {
  it('renders a real value with tabular figures', () => {
    render(<KpiRow kpis={kpis} />)
    expect(screen.getByText('31,893')).toBeInTheDocument()
    expect(screen.getByText('5.0%')).toBeInTheDocument()
  })

  it('renders an unavailable metric as a dash, never as 0.0%', () => {
    // Bug 3: open rate read 0.0% because the API does not populate it.
    // A dash is the honest rendering; "0.0%" is a lie.
    render(<KpiRow kpis={kpis} />)
    const openRate = screen.getByTestId('kpi-open_rate')
    expect(within(openRate).getByText('—')).toBeInTheDocument()
    expect(within(openRate).queryByText('0.0%')).not.toBeInTheDocument()
  })

  it('marks an unavailable metric so the distinction is machine-readable', () => {
    render(<KpiRow kpis={kpis} />)
    expect(screen.getByTestId('kpi-open_rate')).toHaveAttribute('data-unavailable', 'true')
    expect(screen.getByTestId('kpi-emails_sent')).toHaveAttribute('data-unavailable', 'false')
  })

  it('renders a genuine zero as 0, not as a dash', () => {
    render(<KpiRow kpis={[{ key: 'bounces', label: 'Bounces', value: 0, kind: 'count' }]} />)
    const cell = screen.getByTestId('kpi-bounces')
    expect(within(cell).getByText('0')).toBeInTheDocument()
    expect(cell).toHaveAttribute('data-unavailable', 'false')
  })

  it('labels every KPI so the row is not a row of bare numbers', () => {
    render(<KpiRow kpis={kpis} />)
    expect(screen.getByText('Emails sent')).toBeInTheDocument()
    expect(screen.getByText('Reply rate')).toBeInTheDocument()
  })

  it('explains an implausible rate as human replies exceeding emails sent, not autoresponders', () => {
    // T10d: the reply rate is replies_human / emails_sent. Autoresponders are a
    // separate column and are NOT in this count, so blaming them was a false
    // reason attached to a correct flag.
    render(
      <KpiRow
        kpis={[{ key: 'reply_rate', label: 'Reply rate', value: 4.5, kind: 'rate' }]}
      />,
    )
    const cell = screen.getByTestId('kpi-reply_rate')
    expect(within(cell).getByText('Not reliable')).toBeInTheDocument()
    expect(within(cell).getByText('Reply rate is not reliable. Human replies exceed emails sent.')).toBeInTheDocument()
    // the old, false explanation must not reappear anywhere in the cell
    expect(cell.textContent).not.toMatch(/autoresponder/i)
  })
})

describe('CampaignTable', () => {
  const rows: CampaignRow[] = [
    {
      id: 'c1',
      name: 'PB Signups / Leads',
      status: 'active',
      emails_sent: 31893,
      replies_human: 1357,
      replies_autoresponder: 39,
      bounces: 120,
      opportunities: 22,
      reply_rate: 0.0426,
      bounce_rate: 0.0038,
      open_rate: null,
      unsubscribe: null,
      metric_date: '2026-09-30',
    },
  ]

  it('renders the campaign name and its real metrics', () => {
    render(<CampaignTable rows={rows} />)
    expect(screen.getByText('PB Signups / Leads')).toBeInTheDocument()
    expect(screen.getByText('31,893')).toBeInTheDocument()
  })

  it('never renders an impossible rate above 100% as a real result', () => {
    // Bug 2: reply rates of 333% and 450% from autoresponders counted as
    // humans. The table must refuse to present a rate above 100%.
    const impossible: CampaignRow[] = [
      {
        ...rows[0],
        id: 'c2',
        name: 'IRS Penalty Back - Emails Instantly',
        reply_rate: 4.5, // 450%
      },
    ]
    render(<CampaignTable rows={impossible} />)
    expect(screen.queryByText('450.0%')).not.toBeInTheDocument()
    expect(screen.getByText('Not reliable')).toBeInTheDocument()
  })

  it('gives the table footer a true reason: human replies exceed emails sent', () => {
    // T10d: the footer used to say autoresponders were included in the count.
    // They are not — reply_rate is replies_human / emails_sent, so the two
    // flagged campaigns (9 replies / 2 sent, 10 / 3) have zero autoresponders.
    const impossible: CampaignRow[] = [
      { ...rows[0], id: 'c2', name: 'IRS Penalty Back - Emails Instantly', reply_rate: 4.5 },
    ]
    render(<CampaignTable rows={impossible} />)
    expect(
      screen.getByText('Reply rate is not reliable. Human replies exceed emails sent.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Autoresponders are included in this count/)).not.toBeInTheDocument()
  })

  it('shows the autoresponder split so the reply rate is auditable', () => {
    render(<CampaignTable rows={rows} />)
    // 1357 human + 39 automatic must both be visible and distinct.
    expect(screen.getByTestId('replies-human-c1')).toHaveTextContent('1,357')
    expect(screen.getByTestId('replies-auto-c1')).toHaveTextContent('39')
  })

  it('renders open rate as unavailable rather than 0.0%', () => {
    render(<CampaignTable rows={rows} />)
    const cell = screen.getByTestId('open-rate-c1')
    expect(within(cell).getByText('—')).toBeInTheDocument()
    expect(within(cell).queryByText('0.0%')).not.toBeInTheDocument()
  })

  it('renders an empty campaign list as a first-run state, not a crash', () => {
    render(<CampaignTable rows={[]} />)
    expect(screen.getByTestId('campaign-table')).toBeInTheDocument()
    expect(screen.getByTestId('campaign-table-empty')).toBeInTheDocument()
  })

  it('renders a campaign with no metrics at all without inventing zeros', () => {
    const blank: CampaignRow[] = [
      {
        id: 'c3',
        name: 'TapDash Jewelry Retailers - Test 01',
        status: 'draft',
        emails_sent: null,
        replies_human: null,
        replies_autoresponder: null,
        bounces: null,
        opportunities: null,
        reply_rate: null,
        bounce_rate: null,
        open_rate: null,
        unsubscribe: null,
        metric_date: null,
      },
    ]
    render(<CampaignTable rows={blank} />)
    const cell = screen.getByTestId('emails-sent-c3')
    expect(within(cell).getByText('—')).toBeInTheDocument()
  })
})

describe('SenderHealthPanel', () => {
  const health: SenderHealth = {
    mailbox_count: 12,
    healthy_mailboxes: 10,
    warmup_avg: 86.4,
    daily_limit: 480,
    setup_pending: 1,
  }

  it('renders mailbox counts from the source', () => {
    render(<SenderHealthPanel health={health} />)
    expect(screen.getByTestId('mailbox-count')).toHaveTextContent('12')
    expect(screen.getByTestId('healthy-count')).toHaveTextContent('10')
  })

  it('renders a dash when the fleet size is unknown', () => {
    render(<SenderHealthPanel health={{ ...health, mailbox_count: null, healthy_mailboxes: null }} />)
    expect(screen.getByTestId('mailbox-count')).toHaveTextContent('—')
  })

  it('shows the unconnected count as the remainder, not an invented number', () => {
    render(<SenderHealthPanel health={health} />)
    expect(screen.getByTestId('unhealthy-count')).toHaveTextContent('2')
  })
})

describe('TrendChartArea', () => {
  it('renders a real trend with at least two points', () => {
    const points: TrendPoint[] = [
      { day: '2026-09-28', value: 100 },
      { day: '2026-09-29', value: 140 },
      { day: '2026-09-30', value: 120 },
    ]
    render(<TrendChartArea series={points} label="Emails sent" />)
    expect(screen.getByTestId('trend-chart')).toBeInTheDocument()
    expect(screen.getByTestId('trend-point-count')).toHaveTextContent('3')
  })

  it('renders an empty-history first run as a real state, not a crash', () => {
    // Bug 4: one day of history. An empty series must look intentional.
    render(<TrendChartArea series={[]} label="Emails sent" />)
    expect(screen.getByTestId('trend-chart')).toBeInTheDocument()
    expect(screen.getByTestId('trend-empty')).toBeInTheDocument()
  })

  it('renders a single day of history without pretending to be a trend', () => {
    render(<TrendChartArea series={[{ day: '2026-09-30', value: 120 }]} label="Emails sent" />)
    expect(screen.getByTestId('trend-chart')).toBeInTheDocument()
    // A single point is not a trend and must be labelled as such.
    expect(screen.getByTestId('trend-single')).toBeInTheDocument()
  })
})

describe('FreshnessIndicator', () => {
  it('renders the source timestamp', () => {
    render(<FreshnessIndicator generatedAt="2026-09-30T14:05:00Z" stale={false} />)
    expect(screen.getByTestId('freshness')).toBeInTheDocument()
  })

  it('marks a stale snapshot as stale', () => {
    render(<FreshnessIndicator generatedAt="2026-09-29T14:05:00Z" stale />)
    expect(screen.getByTestId('freshness')).toHaveAttribute('data-stale', 'true')
  })

  it('renders a dash rather than a fabricated time when the timestamp is missing', () => {
    render(<FreshnessIndicator generatedAt={null} stale />)
    expect(screen.getByTestId('freshness-time')).toHaveTextContent('—')
  })
})
