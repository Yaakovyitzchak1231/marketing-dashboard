/**
 * @vitest-environment jsdom
 *
 * These suites render React components, so they need a DOM. Declared here
 * rather than globally so the pure-logic `.test.ts` suites keep running in
 * `node`.
 */
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
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

describe('CampaignTable controls', () => {
  /**
   * A row with nothing reported on it, spread from by every fixture here.
   *
   * Nulls are the realistic default for this data: the Instantly API does not
   * populate `open_rate` at all, and a campaign that has just been created has
   * reported nothing yet. A fixture of tidy non-null numbers would hide every
   * defect these tests exist to catch.
   */
  const base: CampaignRow = {
    id: 'c1',
    name: 'Alpha',
    status: 'active',
    emails_sent: null,
    replies_human: null,
    replies_autoresponder: null,
    bounces: null,
    opportunities: null,
    reply_rate: null,
    bounce_rate: null,
    open_rate: null,
    unsubscribe: null,
    metric_date: '2026-09-30',
  }

  const rows: CampaignRow[] = [
    { ...base, id: 'a', name: 'Alpha' },
    { ...base, id: 'b', name: 'Bravo' },
  ]

  /**
   * The campaign names in the order they are on screen.
   *
   * Read from the DOM rather than from a prop, because the thing under test is
   * the ORDER the table put the rows in. The name is the first child of the
   * `.min-w-0` cell in each row.
   */
  function renderedNames(): string[] {
    return Array.from(screen.getByTestId('campaign-table').querySelectorAll('li')).map(
      (row) => row.querySelector('.min-w-0 > div')?.textContent ?? '',
    )
  }

  function setSort(value: string): void {
    fireEvent.change(screen.getByLabelText('Sort campaigns'), { target: { value } })
  }

  function toggleDirection(): void {
    fireEvent.click(screen.getByRole('button', { name: /^(Ascending|Descending)$/ }))
  }

  it('orders by emails_sent when sorting by Sent', () => {
    // A sort whose key was the HEADING ("Sent") instead of the FIELD
    // (`emails_sent`) is a silent no-op: the list does something, so it looks
    // like it sorted, and nothing reports an error. Reading the option value as
    // a field name is what makes that impossible.
    const rows: CampaignRow[] = [
      { ...base, id: 'a', name: 'Alpha', emails_sent: 100 },
      { ...base, id: 'b', name: 'Bravo', emails_sent: 300 },
      { ...base, id: 'c', name: 'Charlie', emails_sent: 200 },
    ]
    render(<CampaignTable rows={rows} />)

    setSort('emails_sent')
    expect(renderedNames()).toEqual(['Alpha', 'Charlie', 'Bravo'])

    toggleDirection()
    expect(renderedNames()).toEqual(['Bravo', 'Charlie', 'Alpha'])
  })

  it('ranks an unreported metric below every reported one in both directions', () => {
    // Bug 3 in the render path: `open_rate` is never populated by the API, so
    // `?? -Infinity` made every unreported row the SMALLEST value -- first on an
    // ascending sort, then reshuffled to the other end on the next click. Both
    // halves of that reshuffle are asserted below, because a test that only
    // fails in one direction is not a test.
    const rows: CampaignRow[] = [
      { ...base, id: 'a', name: 'Alpha', open_rate: 0.2 },
      { ...base, id: 'b', name: 'Bravo', open_rate: null },
      { ...base, id: 'c', name: 'Charlie', open_rate: 0.1 },
    ]
    render(<CampaignTable rows={rows} />)

    setSort('open_rate')
    expect(renderedNames().at(-1)).toBe('Bravo')
    // Read the CELL the sink is supposed to produce, not the name column:
    // `renderedNames()` returns names, so asking it about a rate string can
    // never fail. The rank is only defensible if the unreported row is printed
    // as unreported -- UNAVAILABLE, not the "Not reliable" suppression, which
    // would claim the source said something unreliable when it said nothing.
    expect(screen.getByTestId('open-rate-b')).toHaveTextContent('—')

    toggleDirection()
    // A null is last in BOTH directions, so the two order assertions cannot
    // tell a live click from a dead handler. The button's accessible name IS its
    // visible text -- no `aria-label`, WCAG 2.5.3 -- so a click that did nothing
    // leaves it reading "Ascending" and this fails.
    expect(screen.getByRole('button', { name: 'Descending' })).toBeInTheDocument()
    expect(renderedNames().at(-1)).toBe('Bravo')
  })

  it('does not order by a rate the table refuses to print', () => {
    // The autoresponder bug, ranked instead of rendered. A 450% `reply_rate`
    // prints "Not reliable" in its own cell, so a sort that reads the raw value
    // is ordering the list by a figure the table next to it declines to print.
    const reply: CampaignRow[] = [
      { ...base, id: 'a', name: 'Alpha', reply_rate: 0.01 },
      { ...base, id: 'b', name: 'Bravo', reply_rate: 4.5 },
    ]
    const { unmount } = render(<CampaignTable rows={reply} />)
    setSort('reply_rate')
    expect(renderedNames().at(-1)).toBe('Bravo')
    toggleDirection()
    // Same gap as the `open_rate` test above: an unrankable row sinks in both
    // directions, so the order alone cannot prove the click landed.
    expect(screen.getByRole('button', { name: 'Descending' })).toBeInTheDocument()
    expect(renderedNames().at(-1)).toBe('Bravo')
    unmount()

    // `open_rate` is the second rate key, and the one that made this worse: a
    // percentage-point value stored where a fraction is expected (86.4) is above
    // 1, so its cell reads "Not reliable" while "Open rate -> Descending" ranked
    // it FIRST. Asserted on the source-order-first row, so an unguarded
    // descending sort puts it visibly at the top.
    const open: CampaignRow[] = [
      { ...base, id: 'a', name: 'Alpha', open_rate: 4.5 },
      { ...base, id: 'c', name: 'Charlie', open_rate: 0.2 },
    ]
    render(<CampaignTable rows={open} />)
    setSort('open_rate')
    expect(renderedNames().at(-1)).toBe('Alpha')
    toggleDirection()
    expect(screen.getByRole('button', { name: 'Descending' })).toBeInTheDocument()
    expect(renderedNames()).toEqual(['Charlie', 'Alpha'])
  })

  it('offers only the statuses the rows actually have', () => {
    // `status` is typed `string | null`, but the shell model copies it straight
    // off the API response, so a payload that omits the key puts `undefined` in
    // the set. A `value={value as string}` cast then renders an option with no
    // text at all -- a blank entry nobody can read or select.
    const rows: CampaignRow[] = [
      { ...base, id: 'a', name: 'Alpha', status: 'active' },
      { ...base, id: 'b', name: 'Bravo', status: null },
      { ...base, id: 'c', name: 'Charlie', status: 'draft' },
    ]
    render(<CampaignTable rows={rows} />)

    const select = screen.getByLabelText('Filter campaigns by status') as HTMLSelectElement
    const labels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent)
    // Asserted on the exact SET, because the extra option is silent rather than
    // loud: `{null}` renders as no text, so matching the word "null" against the
    // select's textContent can never fail. The option LIST is the only place on
    // screen that carries the defect.
    expect(labels).toEqual(['All statuses', 'active', 'draft'])
  })

  it('states the truncated load and the filtered count independently', () => {
    // Two claims that used to be two branches of one `?:`: "the source holds 14
    // and we fetched 2" (the load) and "one of those two is on screen" (the
    // view). Both are true at once while a filter narrows the view, so a filter
    // must not be able to silence the load, and a truncated load must not be
    // able to silence the view.
    const truncated = render(<CampaignTable rows={rows} total={14} />)
    // Asserted on textContent rather than with `getByText`: the digits are
    // wrapped in `<Figure>` so they hold their columns, which means no single
    // element owns the whole sentence. That structure is deliberate and must not
    // be undone to make a test easier to write.
    const table = screen.getByTestId('campaign-table')
    expect(table).toHaveTextContent('Showing 2 of 14 campaigns')

    fireEvent.change(screen.getByLabelText('Search campaigns by name'), {
      target: { value: 'Alpha' },
    })
    expect(table).toHaveTextContent('Showing 2 of 14 campaigns')
    expect(table).toHaveTextContent('1 of 2 shown')
    truncated.unmount()

    // A total past a thousand, because that is where the separator showed. The
    // notice interpolated its numbers raw while every other figure on the page
    // went through `formatCount`, so the same stored count was on screen twice
    // in two spellings -- "1482" in the disclosure and "1,482" in the cells.
    const large = render(<CampaignTable rows={rows} total={1482} />)
    expect(screen.getByTestId('campaign-table')).toHaveTextContent(
      'Showing 2 of 1,482 campaigns',
    )
    large.unmount()

    // A total equal to the loaded rows is not a truncated load, so there is
    // nothing to disclose and no claim may be made about one.
    const complete = render(<CampaignTable rows={rows} total={rows.length} />)
    const whole = screen.getByTestId('campaign-table')
    expect(whole).not.toHaveTextContent(/Showing \d+ of \d+ campaigns/)
    expect(whole).toHaveTextContent('2 shown')
    complete.unmount()

    // The source reported no total at all. `total={null}` must not become a
    // number -- inventing one is how a caller ends up reading "Showing 2 of 0".
    const noTotal = render(<CampaignTable rows={rows} total={null} />)
    const unreported = screen.getByTestId('campaign-table')
    expect(unreported).not.toHaveTextContent(/Showing \d+ of \d+ campaigns/)
    expect(unreported).toHaveTextContent('2 shown')
  })

  it('distinguishes a filtered-to-nothing list from an empty one', () => {
    // Rows exist and the filters exclude all of them. That is a different fact
    // from "this range has no campaigns in it", and a table that renders both
    // bodies at once contradicts itself in the space of one card.
    const filtered = render(<CampaignTable rows={rows} />)
    fireEvent.change(screen.getByLabelText('Search campaigns by name'), {
      target: { value: 'nothing matches this' },
    })
    expect(screen.getByTestId('campaign-table-no-match')).toBeInTheDocument()
    expect(screen.queryByTestId('campaign-table-empty')).toBeNull()
    filtered.unmount()

    // And the empty state cannot contradict itself either: with no rows there is
    // no view to count and no load to disclose, so "Showing 0 of 148 campaigns"
    // directly above "No campaigns have reported metrics in this range yet."
    // states two incompatible things. The controls go with the rows too -- they
    // have nothing to act on, and a search box over an empty list invites the
    // reader to conclude the search is broken.
    render(<CampaignTable rows={[]} total={148} />)
    expect(screen.getByTestId('campaign-table-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('campaign-table-no-match')).toBeNull()
    expect(screen.queryByTestId('campaign-table-controls')).toBeNull()
    expect(screen.getByTestId('campaign-table')).not.toHaveTextContent('Showing 0 of')
  })

  it('discloses truncation from the row cap alone when no count came back', () => {
    // The backstop. `total` is null whenever the source could not produce a
    // count we are willing to stand behind -- see verifyCampaignTotal -- and
    // before this existed the table treated that as "nothing was truncated".
    // That is how a capped list went quietly short in the first place.
    //
    // The limit is 2 rather than 100 purely so the fixture stays small. The
    // rule under test is `loaded >= rowLimit`, which is the same rule at any
    // value: hitting the cap is the evidence.
    const capped: CampaignRow[] = [
      { ...base, id: 'a', name: 'Alpha' },
      { ...base, id: 'b', name: 'Bravo' },
    ]

    render(<CampaignTable rows={capped} total={null} rowLimit={2} />)
    const table = screen.getByTestId('campaign-table')
    expect(table).toHaveTextContent('Showing the first 2 campaigns. There may be more.')
    // No count was published, so the notice must not name one.
    expect(table).not.toHaveTextContent(/Showing \d+ of \d+ campaigns/)
  })

  it('claims nothing about completeness when the cap did not bind', () => {
    // Fewer rows than the cap: the query returned everything it was asked for,
    // so there is no truncation to disclose -- and inventing one would be as
    // wrong as hiding one.
    const rows: CampaignRow[] = [
      { ...base, id: 'a', name: 'Alpha' },
      { ...base, id: 'b', name: 'Bravo' },
    ]

    render(<CampaignTable rows={rows} total={null} rowLimit={100} />)
    const table = screen.getByTestId('campaign-table')
    expect(table).not.toHaveTextContent(/Showing \d+ of \d+ campaigns/)
    expect(table).not.toHaveTextContent('There may be more')
    expect(table).toHaveTextContent('2 shown')
  })

  it('prefers the exact count over the cap when both are available', () => {
    // A real count names both numbers, which is strictly more useful than
    // "there may be more". The cap must not paper over a number we can state.
    const rows: CampaignRow[] = [
      { ...base, id: 'a', name: 'Alpha' },
      { ...base, id: 'b', name: 'Bravo' },
    ]

    render(<CampaignTable rows={rows} total={148} rowLimit={2} />)
    const table = screen.getByTestId('campaign-table')
    expect(table).toHaveTextContent('Showing 2 of 148 campaigns')
    expect(table).not.toHaveTextContent('There may be more')
  })

  it('makes no completeness claim when neither a count nor a cap was reported', () => {
    // Both signals absent. There is genuinely nothing to say, and the honest
    // rendering is silence rather than a guess in either direction.
    const rows: CampaignRow[] = [{ ...base, id: 'a', name: 'Alpha' }]

    render(<CampaignTable rows={rows} />)
    const table = screen.getByTestId('campaign-table')
    expect(table).not.toHaveTextContent(/Showing \d+ of \d+ campaigns/)
    expect(table).not.toHaveTextContent('There may be more')
    expect(table).toHaveTextContent('1 shown')
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

  /**
   * Regression: the live dashboard showed "Collected —" with data-stale=false.
   *
   * With no timestamp and no reported failure, the old two-state prop fell back
   * to the `Collected` label and asserted the snapshot was NOT stale, while the
   * value beside it was an explicit "not reported by the source". The line told
   * Jacob the data was current at the same moment it admitted it did not know
   * when the data arrived. A missing timestamp is not evidence of freshness.
   */
  it('does not claim a collection time when the source reports none', () => {
    render(<FreshnessIndicator generatedAt={null} stale={false} />)
    const el = screen.getByTestId('freshness')
    expect(el).toHaveAttribute('data-freshness', 'unknown')
    expect(el).not.toHaveTextContent('Collected')
    expect(el).toHaveTextContent('Collection time unknown')
    expect(screen.getByTestId('freshness-time')).toHaveTextContent('—')
  })

  it('reports a real collection time as fresh', () => {
    render(
      <FreshnessIndicator generatedAt="2026-09-30T14:05:00Z" stale={false} />,
    )
    const el = screen.getByTestId('freshness')
    expect(el).toHaveAttribute('data-freshness', 'fresh')
    expect(screen.getByTestId('freshness-time')).not.toHaveTextContent('—')
  })

  it('keeps a reported failure distinct from an unknown time', () => {
    render(<FreshnessIndicator generatedAt={null} stale />)
    const el = screen.getByTestId('freshness')
    expect(el).toHaveAttribute('data-freshness', 'failed')
    expect(el).toHaveTextContent('Last collection failed')
  })
})
