import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ReplyTrendChart } from '@/components/charts/ReplyTrendChart'
import { OpportunityValuePanel } from '@/components/charts/OpportunityValuePanel'
import { SenderHealthPanel } from '@/components/charts/SenderHealthPanel'
import { COPY } from '@/lib/copy'
import type { TrendPoint } from '@/lib/charts'

afterEach(cleanup)

const point = (o: Partial<TrendPoint> = {}): TrendPoint => ({
  metric_date: '2026-09-28',
  emails_sent: 100,
  replies_human: 2,
  replies_autoresponder: 0,
  reply_rate: 0.02,
  open_rate: null,
  unreliable: false,
  ...o,
})

// ---------------------------------------------------------------------------
// ReplyTrendChart
// ---------------------------------------------------------------------------
describe('ReplyTrendChart', () => {
  it('renders the human reply rate as a percentage from raw counts', () => {
    render(<ReplyTrendChart points={[point({ emails_sent: 1000, replies_human: 50, reply_rate: 0.05 })]} />)
    expect(screen.getByText('5.0%')).toBeTruthy()
    expect(screen.getByText(/Human reply rate/)).toBeTruthy()
  })

  it('labels the series as human replies, never as a bare "reply rate"', () => {
    render(<ReplyTrendChart points={[point()]} />)
    expect(screen.getByText('Human reply rate')).toBeTruthy()
  })

  it('renders the empty state as "Collecting history", not an error and not a blank box', () => {
    render(<ReplyTrendChart points={[]} />)
    expect(screen.getByText(COPY.trendEmpty)).toBeTruthy()
    expect(screen.queryByText(COPY.error)).toBeNull()
    // A single point is not a trend.
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows the unreliable copy when a day exceeds 100% — and does not hide the number', () => {
    render(
      <ReplyTrendChart
        points={[point({ emails_sent: 2, replies_human: 9, reply_rate: 4.5, unreliable: true })]}
      />,
    )
    expect(screen.getByText(COPY.replyRateUnreliable)).toBeTruthy()
    expect(screen.getByText('450.0%')).toBeTruthy()
    // the raw number is never silently corrected or clamped
    expect(screen.queryByText('100%')).toBeNull()
  })

  it('does not show the unreliable copy for a plausible rate', () => {
    render(<ReplyTrendChart points={[point()]} />)
    expect(screen.queryByText(COPY.replyRateUnreliable)).toBeNull()
  })

  it('renders "Not reported by Instantly" for open rate, never 0.0%', () => {
    render(<ReplyTrendChart points={[point()]} showOpenRate />)
    expect(screen.getByText(COPY.metricUnavailable)).toBeTruthy()
    expect(screen.queryByText('0.0%')).toBeNull()
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('renders a missing daily rate as a dash, never as 0%', () => {
    render(<ReplyTrendChart points={[point({ emails_sent: null, replies_human: null, reply_rate: null })]} />)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('draws the line as two strokes when a day is missing — a gap is not an edge', () => {
    const { container } = render(
      <ReplyTrendChart
        points={[
          point({ metric_date: '2026-09-28', reply_rate: 0.01 }),
          point({ metric_date: '2026-09-29', reply_rate: null, emails_sent: null, replies_human: null }),
          point({ metric_date: '2026-09-30', reply_rate: 0.03 }),
        ]}
      />,
    )
    const paths = container.querySelectorAll('path[data-series]')
    expect(paths.length).toBe(1)
    // one <path> carrying two M commands = two separate strokes
    const d = paths[0].getAttribute('d') ?? ''
    expect((d.match(/M/g) || []).length).toBe(2)
    for (const p of Array.from(paths)) expect(p.getAttribute('d') ?? '').not.toContain('NaN')
  })

  it('never emits NaN geometry for an all-missing series', () => {
    const { container } = render(
      <ReplyTrendChart
        points={[point({ reply_rate: null, emails_sent: null, replies_human: null }),
                point({ metric_date: '2026-09-29', reply_rate: null, emails_sent: null, replies_human: null })]}
      />,
    )
    const paths = Array.from(container.querySelectorAll('path[data-series]'))
    for (const p of paths) expect(p.getAttribute('d') ?? '').not.toContain('NaN')
  })

  it('renders each day as a labelled row so the data is readable without hovering', () => {
    render(
      <ReplyTrendChart
        points={[point({ metric_date: '2026-09-28', emails_sent: 100, replies_human: 8, reply_rate: 0.08 })]}
      />,
    )
    expect(screen.getByText('2026-09-28')).toBeTruthy()
    expect(screen.getByText('8')).toBeTruthy()
    expect(screen.getByText('100')).toBeTruthy()
  })

  it('uses tabular figures so the numbers line up in a column', () => {
    const { container } = render(<ReplyTrendChart points={[point()]} />)
    expect(container.querySelector('[data-tabular]')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// OpportunityValuePanel
// ---------------------------------------------------------------------------
describe('OpportunityValuePanel', () => {
  it('labels open pipeline value as pipeline, never as revenue', () => {
    render(<OpportunityValuePanel openValue={1335000} openCount={1335} />)
    expect(screen.getByText('Open pipeline value')).toBeTruthy()
    expect(screen.queryByText(/^Revenue$/)).toBeNull()
  })

  it('renders a known value with its currency formatting', () => {
    render(<OpportunityValuePanel openValue={1335000} openCount={1335} />)
    expect(screen.getByText('$1,335,000')).toBeTruthy()
  })

  it('computes mean value per opportunity from the raw pair', () => {
    render(<OpportunityValuePanel openValue={1000} openCount={4} />)
    expect(screen.getByText('$250 average')).toBeTruthy()
  })

  it('renders an unknown value as unavailable, never as $0', () => {
    render(<OpportunityValuePanel openValue={null} openCount={3} />)
    expect(screen.getAllByText(COPY.metricUnavailable).length).toBeGreaterThan(0)
    expect(screen.queryByText('$0')).toBeNull()
  })

  it('does not divide by a zero count', () => {
    const { container } = render(<OpportunityValuePanel openValue={1000} openCount={0} />)
    expect(screen.getByText(COPY.metricUnavailable)).toBeTruthy()
    expect(container.textContent).not.toContain('Infinity')
    expect(container.textContent).not.toContain('NaN')
  })

  it('shows the open count as a count beside the value', () => {
    render(<OpportunityValuePanel openValue={1000} openCount={3} />)
    expect(screen.getByText('$1,000')).toBeTruthy()
    expect(screen.getByText('3 open')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// SenderHealthPanel
// ---------------------------------------------------------------------------
describe('SenderHealthPanel', () => {
  it('computes the healthy share from raw counts', () => {
    render(<SenderHealthPanel total={5} healthy={4} />)
    expect(screen.getByText('80%')).toBeTruthy()
  })

  it('reports the healthy and unhealthy counts as counts', () => {
    render(<SenderHealthPanel total={5} healthy={4} />)
    expect(screen.getByText(/4 of 5 healthy/)).toBeTruthy()
    expect(screen.getByText(/1 unhealthy/)).toBeTruthy()
  })

  it('renders a zero-mailbox fleet as unavailable, not as 0%', () => {
    render(<SenderHealthPanel total={0} healthy={0} />)
    expect(screen.getByText(COPY.metricUnavailable)).toBeTruthy()
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('renders an unknown healthy count as unavailable', () => {
    render(<SenderHealthPanel total={5} healthy={null} />)
    expect(screen.getByText(COPY.metricUnavailable)).toBeTruthy()
  })

  it('surfaces a contradictory fleet rather than rendering 250% as fact', () => {
    render(<SenderHealthPanel total={2} healthy={5} />)
    expect(screen.getByText('250%')).toBeTruthy()
    expect(screen.getByText(/more mailboxes marked healthy than exist/i)).toBeTruthy()
  })

  it('lists per-mailbox health when the data provides it', () => {
    render(
      <SenderHealthPanel
        total={2}
        healthy={1}
        mailboxes={[
          { email: 'a@example.com', status: 'healthy' },
          { email: 'b@example.com', status: 'unhealthy' },
        ]}
      />,
    )
    expect(screen.getByText('a@example.com')).toBeTruthy()
    expect(screen.getByText('b@example.com')).toBeTruthy()
  })
})
