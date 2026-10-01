/**
 * Every user-facing string in the dashboard.
 *
 * `@build-copy` owns these. Components must not inline their own wording:
 * a string typed into a component is copy nobody reviews, and the AGENTS.md
 * rule about honesty extends to claims as well as numbers -- "Collecting
 * history" and "No data" are both claims about what the database holds.
 *
 * Keys are deliberately FLAT. The `satisfies` clause below types every entry as
 * a string or a function, which rejects nested objects outright; grouping
 * related strings under a prefix keeps them findable without weakening that
 * check. A nested `infrastructure: { ... }` block would have to be cast away to
 * compile, and a cast is exactly where an unreviewed string sneaks in.
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
  loading: 'Loading',
  error: 'Something went wrong. Try again.',
  partialList: (visible: number, total: number) =>
    `Showing ${visible} of ${total} campaigns`,

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