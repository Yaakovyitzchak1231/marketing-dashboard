import { formatCount } from '@/lib/format'

/**
 * Every user-facing string in the dashboard.
 *
 * `@build-copy` owns these. Components must not inline their own wording:
 * a string typed into a component is copy nobody reviews, and the AGENTS.md
 * rule about honesty extends to claims as well as numbers -- "Collecting
 * history" and "No data" are both claims about what the database holds.
 *
 * Keys are FLAT, or grouped exactly one level deep by surface --
 * `COPY.infrastructure.title` names its owner, which a flat `infrastructureTitle`
 * does not. The `satisfies` clause below is what keeps that safe: it types an
 * entry as a string, a function, or a group of those, so a nested block still
 * cannot become a place to stash a component or a piece of data. Deeper
 * nesting would need a cast, and a cast is exactly where an unreviewed string
 * sneaks in.
 */

/**
 * A copy value is a fixed string, a function of the numbers it describes, or a
 * nested group of them.
 *
 * Grouping related strings is worth supporting: `COPY.infrastructure.title`
 * reads better at the call site than `COPY.infrastructureTitle`, and the
 * original `satisfies Record<string, string | Fn>` shape silently forbade it.
 * The nested branch is kept narrow on purpose -- an object of copy values,
 * nothing else -- so it cannot become a place to stash data or a component.
 */
type CopyValue =
  | string
  | ((...args: never[]) => string)
  | { readonly [k: string]: CopyValue }

export const COPY = {
  metricUnavailable: 'Not reported by Instantly',
  replyRateUnreliable: 'Reply rate is unreliable. Autoresponders are included in this count.',
  trendEmpty: 'Collecting history',
  staleDataOk: (lastCollectedAt: string) => `Collected ${lastCollectedAt}`,
  staleDataFailed: 'Last collection failed',
  /**
   * The source reported no collection time and no failure either.
   *
   * A distinct state rather than a variant of "Collected": the old fallback
   * printed "Collected —" and marked the row not-stale, which claims the data
   * is current while admitting we do not know when it arrived. Saying so
   * outright is both more honest and more useful -- it tells Jacob the fix is
   * to look at the collector, not that the numbers are fine.
   */
  freshnessUnknown: 'Collection time unknown',
  loading: 'Loading',
  error: 'Something went wrong. Try again.',
  /**
   * The truncation disclosure, naming two figures.
   *
   * Both go through `formatCount` because every other figure on the page does:
   * interpolated raw, a total of 1482 printed "Showing 2 of 1482 campaigns" two
   * inches from a table whose cells read "1,482" -- two renderings of one
   * number on one screen, which is the AGENTS.md rule (a figure must be
   * traceable to its source) failing at the last step before the reader.
   */
  partialList: (visible: number, total: number) =>
    `Showing ${formatCount(visible)} of ${formatCount(total)} campaigns`,

  /**
   * The infrastructure page's expiry warning, in words.
   *
   * Takes the count so the sentence is assembled in one place -- an earlier
   * draft interpolated the count separately and rendered "3  expiring within
   * 14 days" with a stray space. The plural is handled here so a single expiring
   * domain does not read "1 domains".
   *
   * The window itself is EXPIRY_WINDOW_DAYS from lib/expiry.ts, which the API
   * route also imports, so this sentence can never advertise a different
   * horizon than the query that flagged the rows.
   */
  domainsExpiring: (count: number, days: number) =>
    `${count} ${count === 1 ? 'domain' : 'domains'} expiring within ${days} days`,

  /** Grouped by surface: `COPY.infrastructure.title` names its owner. */
  infrastructure: {
    title: 'Infrastructure',
    subtitle: 'Domains and inboxes: what is unhealthy, what expires soon.',
    domains: 'Domains',
    inboxes: 'Inboxes',
    noDomains: 'No domains recorded.',
    noInboxes: 'No inboxes recorded.',
    unavailable: 'Infrastructure data is unavailable right now.',
  },

  funnel: {
    title: 'Funnel',
    byIdea: 'By idea',
    byCampaign: 'By campaign',
    noRows: (label: string) => `No ${label} funnel data yet.`,
    unavailable: 'Funnel data is unavailable right now.',
  },

  /**
   * The campaign table's filter and sort controls, and the words its header
   * builds its shown-count from.
   *
   * They live here so they are reviewed like any other copy. A control that
   * narrows the list is a claim about what is on screen, and the wording that
   * carries that claim -- what the search field says, what the status list
   * offers, what the sort control is called -- is exactly the sort of thing
   * that gets retyped inline until nobody owns it.
   */
  campaigns: {
    /**
     * The search field's label for a screen reader, which describes what the
     * field matches. Deliberately not a restatement of the placeholder: the
     * placeholder is a prompt that disappears on the first keystroke, and a
     * label is the field's name.
     */
    searchLabel: 'Search campaigns by name',
    searchPlaceholder: 'Search campaigns',
    statusFilterLabel: 'Filter campaigns by status',
    allStatuses: 'All statuses',
    sortLabel: 'Sort campaigns',
    sortName: 'Name',
    sortSent: 'Sent',
    sortReplyRate: 'Reply rate',
    sortOpenRate: 'Open rate',
    sortAscending: 'Ascending',
    sortDescending: 'Descending',
    /**
     * The direction toggle's tooltip: what clicking it WILL do. The visible
     * text stays the accessible name (WCAG 2.5.3, Label in Name) -- a button
     * that reads "Ascending" while announcing "Sort descending" tells a
     * screen-reader user the opposite of what the screen says.
     */
    sortDirectionAction: (current: 'asc' | 'desc') =>
      current === 'asc' ? 'Sort descending' : 'Sort ascending',
    noMatch: 'No campaigns match these filters.',
    /**
     * The connective words of the header's shown-count -- "2 of 14 shown".
     *
     * The sentence is NOT assembled here on purpose. Its digits have to render
     * inside `<Figure>` so the numbers hold their columns like every other
     * figure on the page, and a string returned from this file cannot carry an
     * element. So copy owns the words, the component owns the JSX, and the
     * reader can see both halves in the two files instead of trusting one.
     */
    countOf: 'of',
    countShown: 'shown',
  },

  costManager: {
    title: 'Costs',
    datePlaceholder: 'Date',
    /**
     * The amount field's example. It lives in copy rather than inline because
     * a numeric literal in the render path fails the fabrication test -- and
     * the test is right to: an example figure typed into a component is one
     * more number nobody traced back to a source.
     */
    amountPlaceholder: '0.00',
    categoryLabel: 'Category',
    addLabel: 'Add cost',
    totalLabel: 'Total',
    historyTitle: 'History',
    noneRecorded: 'No costs recorded yet.',
    nonNegative: 'Enter a non-negative amount.',
  },
} as const satisfies Record<string, CopyValue>

export type CopyKey = keyof typeof COPY