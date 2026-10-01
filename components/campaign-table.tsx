'use client'

import { useMemo, useState } from 'react'
import { formatCount, formatRate, formatDate, rateIsPlausible, isUnavailable } from '@/lib/format'
import { Card, SectionLabel, Figure, Unavailable } from '@/components/primitives'
import { COPY } from '@/lib/copy'

/**
 * One campaign's row. Field names mirror `/api/campaigns` exactly (T3) so the
 * page never has to remap or guess. Every numeric field is `number | null`.
 */
export type CampaignRow = {
  id: string
  name: string
  status: string | null
  emails_sent: number | null
  replies_human: number | null
  replies_autoresponder: number | null
  bounces: number | null
  opportunities: number | null
  reply_rate: number | null
  bounce_rate: number | null
  open_rate: number | null
  unsubscribe: number | null
  metric_date: string | null
}

/**
 * A rate above 100% is not a result -- it is the autoresponder bug (333%, 450%)
 * surfacing again. We refuse to print it as a measurement. The raw human and
 * autoresponder counts sit beside it, so the reader can see why.
 */
function rateIsImplausible(value: number | null): boolean {
  return !isUnavailable(value) && !rateIsPlausible(value)
}

/**
 * The sort controls. The keys are real `CampaignRow` field names rather than
 * display labels, so the comparator reads a field it can type, and an option
 * value the row does not have cannot be smuggled in untyped.
 *
 * `kind` is how the value has to be READ, not how the option is labelled. A
 * `rate` key is subject to the same plausibility guard `RateCell` applies, and
 * the set below is derived from this field rather than from a list of key names.
 */
const SORT_OPTIONS = [
  { value: 'name', label: COPY.campaigns.sortName, kind: 'name' },
  { value: 'emails_sent', label: COPY.campaigns.sortSent, kind: 'count' },
  { value: 'reply_rate', label: COPY.campaigns.sortReplyRate, kind: 'rate' },
  { value: 'open_rate', label: COPY.campaigns.sortOpenRate, kind: 'rate' },
] as const

type SortOption = (typeof SORT_OPTIONS)[number]
type SortKey = SortOption['value']
/** The sort keys that name a metric rather than the name column. */
type MetricSortKey = Exclude<SortKey, 'name'>
type SortDirection = 'asc' | 'desc'

/**
 * The rate sort keys, derived from SORT_OPTIONS' own `kind`.
 *
 * WHY derived rather than named: `RateCell` applies `rateIsImplausible` to every
 * rate it prints, so a sort that skipped the guard would order the list by a
 * figure the table beside it refuses to print. `open_rate` is passed straight
 * through from the `daily_metrics` row, and a percentage-point value stored
 * where a fraction is expected (86.4) is above 1 -- its cell reads "Not
 * reliable" while "Open rate -> Descending" ranks it first. An earlier draft
 * hardcoded `key === 'reply_rate'` and missed exactly that. Keying the guard off
 * `kind` covers the next rate column added here without a second edit for
 * whoever adds it to forget.
 */
const RATE_SORT_KEYS: ReadonlySet<SortKey> = new Set(
  SORT_OPTIONS.filter((option) => option.kind === 'rate').map((option) => option.value),
)

/** Narrows a raw option value, so an unknown one is dropped, not cast. */
function isSortKey(value: string): value is SortKey {
  return SORT_OPTIONS.some((option) => option.value === value)
}

/**
 * The value a row is ranked by, or null when it cannot be ranked.
 *
 * Two kinds of null arrive here and both are absences, never figures: the
 * source did not report the metric, or it reported a rate the cell beside it
 * refuses to print as a measurement. Ranking a list by a figure we decline to
 * show is the autoresponder bug wearing a different hat, so the cell's guard is
 * applied here too -- once, for every rate key, rather than at each call site.
 */
function sortableMetric(row: CampaignRow, key: MetricSortKey): number | null {
  const value = row[key]
  if (isUnavailable(value)) return null
  if (RATE_SORT_KEYS.has(key) && rateIsImplausible(value)) return null
  return value
}

/**
 * Name order, reversed with the direction toggle so the whole list flips
 * together. It doubles as the tie-break: two rows with nothing to rank between
 * them order by name, which is reproducible, rather than by whatever order the
 * source happened to return them in.
 */
function compareNames(a: CampaignRow, b: CampaignRow, direction: SortDirection): number {
  return direction === 'asc'
    ? a.name.localeCompare(b.name)
    : b.name.localeCompare(a.name)
}

/**
 * The truncation notice, or null when the list is complete.
 *
 * It describes the LOAD -- what the source holds against what we fetched -- and
 * it stays true while a filter narrows the view, which is why it is rendered
 * beside the shown-count rather than in place of it.
 *
 * Two distinct reasons to disclose, and they are not interchangeable:
 *
 *   - We have a count and it exceeds what we loaded. Then we can name both
 *     numbers, and `COPY.partialList` is exact.
 *   - We have no usable count, but the response carried as many rows as the cap
 *     allows. Then the cap itself is the evidence that rows may be missing, and
 *     the strongest honest statement is "there may be more" rather than a
 *     number the source never reported.
 *
 * The second case is why this cannot simply test `total > loaded`: trusting the
 * count alone is what left the list silently short before, because `total` was
 * always null and nothing else was looking.
 */
function truncationNotice(
  total: number | null | undefined,
  loaded: number,
  rowLimit: number | null | undefined,
): string | null {
  if (isUnavailable(total)) {
    return isUnavailable(rowLimit) || loaded < rowLimit
      ? null
      : COPY.campaigns.cappedList(rowLimit as number)
  }
  if ((total as number) <= loaded) return null
  return COPY.partialList(loaded, total as number)
}

/**
 * The header's shown-count: how many rows are on screen, and out of how many
 * were loaded.
 *
 * The digits are JSX, not a copy string, so they can carry `<Figure>` and hold
 * their columns the way every other figure on this page does. `ofAll` is null
 * when no filter is applied, which is the case where there is nothing to be a
 * subset of.
 */
function ShownCount({ shown, ofAll }: { shown: number; ofAll: number | null }) {
  return (
    <span className="text-[11px] text-ink-faint">
      <Figure>{formatCount(shown)}</Figure>
      {isUnavailable(ofAll) ? null : (
        <>
          {' '}
          {COPY.campaigns.countOf} <Figure>{formatCount(ofAll)}</Figure>
        </>
      )}{' '}
      {COPY.campaigns.countShown}
    </span>
  )
}

function CountCell({ value, testId }: { value: number | null; testId?: string }) {
  if (isUnavailable(value)) return <Unavailable testId={testId} />
  return (
    <span data-testid={testId}>
      <Figure>{formatCount(value)}</Figure>
    </span>
  )
}

function RateCell({ value, testId }: { value: number | null; testId?: string }) {
  if (rateIsImplausible(value)) {
    return (
      <span
        data-testid={testId}
        data-unreliable="true"
        className="whitespace-nowrap text-warn"
      >
        Not reliable
      </span>
    )
  }
  if (isUnavailable(value)) return <Unavailable testId={testId} />
  return <Figure>{formatRate(value)}</Figure>
}

/**
 * The columns. `hideOnPhone` columns are dropped from the 390px layout --
 * not because the data is unimportant, but because seven figures stacked in a
 * 390px column is unreadable. The autoresponder split is the one that stays,
 * because it is what makes the reply rate auditable.
 */
const COLUMNS = [
  { key: 'sent', label: 'Sent', align: 'right' as const, hideOnPhone: false },
  { key: 'human', label: 'Replies (human)', align: 'right' as const, hideOnPhone: false },
  { key: 'auto', label: 'Auto', align: 'right' as const, hideOnPhone: true },
  { key: 'replyRate', label: 'Reply rate', align: 'right' as const, hideOnPhone: false },
  { key: 'bounceRate', label: 'Bounce rate', align: 'right' as const, hideOnPhone: true },
  { key: 'openRate', label: 'Open rate', align: 'right' as const, hideOnPhone: false },
]

/** The shared grid: one column for the name, then one per metric. */
const GRID = 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 sm:grid-cols-[minmax(0,2fr)_repeat(6,minmax(0,1fr))]'

function hasUnreliableRate(rows: CampaignRow[]): boolean {
  return rows.some((r) => rateIsImplausible(r.reply_rate) || rateIsImplausible(r.bounce_rate))
}

export function CampaignTable({
  rows,
  total,
  rowLimit,
}: {
  rows: CampaignRow[]
  /**
   * The full count the source knows about. When it exceeds `rows.length` the
   * list is truncated and we say so out loud (COPY.partialList). Omit it when
   * the source did not report a total.
   */
  total?: number | null
  /**
   * How many rows the source was willing to send. Travels with the rows so the
   * table can tell when the cap bound even when no count came back -- the one
   * completeness signal that needs no number to be trusted.
   */
  rowLimit?: number | null
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [sort, setSort] = useState<SortKey>('name')
  const [direction, setDirection] = useState<SortDirection>('asc')

  const statuses = useMemo(
    () =>
      Array.from(
        // `isUnavailable` rather than `!== null`, because the field is typed
        // `string | null` but shell-model copies it straight off the API
        // response: a payload that omits the key puts `undefined` in this set,
        // and an option labelled "undefined" is a filter nobody can read.
        new Set(rows.map((row) => row.status).filter((s): s is string => !isUnavailable(s))),
      ).sort(),
    [rows],
  )
  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return rows
      .filter((row) => {
        const matchesQuery = !normalizedQuery || row.name.toLowerCase().includes(normalizedQuery)
        const matchesStatus = status === 'all' || row.status === status
        return matchesQuery && matchesStatus
      })
      .sort((a, b) => {
        if (sort === 'name') return compareNames(a, b, direction)
        const aValue = sortableMetric(a, sort)
        const bValue = sortableMetric(b, sort)
        // An absent figure is ABSENT, not small. It sinks below every reported
        // value in BOTH directions, so toggling the direction cannot promote
        // "not reported" to the top of the list -- which is the open-rate bug
        // ranked rather than rendered: `?? -Infinity` put every null first on an
        // ascending open-rate sort and then reshuffled them on the next click.
        if (aValue === null) {
          return bValue === null
            ? compareNames(a, b, direction)
            : Number.POSITIVE_INFINITY
        }
        if (bValue === null) return Number.NEGATIVE_INFINITY
        // The two infinities above are the COMPARATOR's return values: the
        // ordering signal `Array#sort` consumes and immediately forgets. They
        // are never read back out, never ranked, and never printed. An earlier
        // draft returned a bare 1 and -1 here, which reads as a figure on
        // screen -- and rightly so: in this file a number that nobody can trace
        // back to a stored row does not belong.
        const delta = aValue - bValue
        return direction === 'asc' ? delta : -delta
      })
  }, [direction, query, rows, sort, status])
  const isEmpty = rows.length === 0
  // No rows means the empty-state body below is the single claim about the
  // list. A notice reading "Showing 0 of 148 campaigns" directly above "No
  // campaigns have reported metrics in this range yet." states two incompatible
  // things, and the current route cannot produce it -- but a contradiction one
  // refactor away is still a contradiction, so the notice is suppressed exactly
  // as the shown-count is.
  const notice = isEmpty ? null : truncationNotice(total, rows.length, rowLimit)
  const isFiltered = filteredRows.length !== rows.length
  /**
   * The two header claims are independent, so they are rendered as two
   * elements rather than as two branches: the notice describes the load and
   * stays true while a filter narrows the view, the count describes the view.
   * The count is dropped only when it would repeat the notice verbatim -- a
   * truncated list with no filter applied.
   */
  const showCount = !isEmpty && !(notice !== null && !isFiltered)

  return (
    <Card testId="campaign-table" className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-line px-5 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <SectionLabel>Campaigns</SectionLabel>
          {notice !== null || showCount ? (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {notice !== null ? (
                <span className="text-[11px] text-warn">{notice}</span>
              ) : null}
              {showCount ? (
                <ShownCount
                  shown={filteredRows.length}
                  ofAll={isFiltered ? rows.length : null}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {!isEmpty ? (
          <div
            data-testid="campaign-table-controls"
            className="flex flex-wrap items-center gap-2 rounded border border-line-soft bg-line-soft/20 p-2 text-[12px]"
          >
            <label className="sr-only" htmlFor="campaign-search">{COPY.campaigns.searchLabel}</label>
            <input
              id="campaign-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={COPY.campaigns.searchPlaceholder}
              className="h-8 min-w-48 flex-1 rounded border border-line bg-transparent px-2.5 text-ink outline-none placeholder:text-ink-faint focus:border-ink-muted focus-visible:ring-2 focus-visible:ring-ink-muted"
            />
            <label className="sr-only" htmlFor="campaign-status">{COPY.campaigns.statusFilterLabel}</label>
            <select id="campaign-status" value={status} onChange={(event) => setStatus(event.target.value)} className="h-8 rounded border border-line bg-surface px-2 text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink-muted">
              <option value="all">{COPY.campaigns.allStatuses}</option>
              {statuses.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <label className="sr-only" htmlFor="campaign-sort">{COPY.campaigns.sortLabel}</label>
            <select
              id="campaign-sort"
              value={sort}
              onChange={(event) => {
                const next = event.target.value
                if (isSortKey(next)) setSort(next)
              }}
              className="h-8 rounded border border-line bg-surface px-2 text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink-muted"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {/* The visible text IS the accessible name. An earlier draft also
                set aria-label to the action ("Sort descending") while the button
                read "Ascending", which is WCAG 2.5.3 and actively contradicts the
                screen for anyone not reading it visually. The action moved to
                title, where it is still available and cannot misname the
                control. */}
            <button
              type="button"
              onClick={() => setDirection((value) => value === 'asc' ? 'desc' : 'asc')}
              className="h-8 rounded border border-line px-2.5 text-ink transition-colors hover:bg-line-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-muted"
              title={COPY.campaigns.sortDirectionAction(direction)}
            >
              {direction === 'asc' ? COPY.campaigns.sortAscending : COPY.campaigns.sortDescending}
            </button>
          </div>
        ) : null}
      </div>

      {isEmpty ? (
        // First-run state. A deliberate, empty table reads as "nothing here
        // yet"; a spinner here would read as "broken".
        <div
          data-testid="campaign-table-empty"
          className="px-5 py-10 text-center text-[13px] text-ink-faint"
        >
          No campaigns have reported metrics in this range yet.
        </div>
      ) : (
        <>
          {/* ONE DOM, two layouts. A table hidden with `display:none` alongside
              a mobile twin would put the same campaign name in the document
              twice -- ambiguous for a screen reader, and for a QA assertion.
              One grid, reflowed by CSS, keeps every figure exactly once. */}
          <div className={GRID} data-testid="campaign-table-grid">
            <div
              className="hidden border-b border-line px-5 py-2 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted sm:block"
              aria-hidden="true"
            >
              Campaign
            </div>
            {COLUMNS.map((c) => (
              <div
                key={c.key}
                className={`hidden border-b border-line px-2 py-2 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted sm:block ${
                  c.align === 'right' ? 'text-right' : 'text-left'
                } ${c.hideOnPhone ? '' : ''}`}
              >
                {c.label}
              </div>
            ))}
          </div>

          {filteredRows.length === 0 ? (
            <div
              data-testid="campaign-table-no-match"
              className="px-5 py-8 text-center text-[13px] text-ink-faint"
            >
              {COPY.campaigns.noMatch}
            </div>
          ) : null}
          <ul className="divide-y divide-line-soft">
            {filteredRows.map((row) => (
              <li key={row.id} className={`${GRID} items-baseline px-5 py-3`}>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">{row.name}</div>
                  <div className="truncate text-[11px] text-ink-faint">
                    {row.status ?? 'status unknown'}
                    {row.metric_date ? ` · ${formatDate(row.metric_date)}` : ''}
                  </div>
                </div>

                <div className="text-right sm:contents">
                  <div className="flex justify-between gap-4 text-[12px] sm:block">
                    <span className="text-ink-muted sm:hidden">Sent</span>
                    <CountCell value={row.emails_sent} testId={`emails-sent-${row.id}`} />
                  </div>
                  <div className="flex justify-between gap-4 text-[12px] sm:block">
                    <span className="text-ink-muted sm:hidden">Replies</span>
                    <span className="flex items-baseline justify-end gap-1.5">
                      <span data-testid={`replies-human-${row.id}`}>
                        {isUnavailable(row.replies_human) ? (
                          <Unavailable />
                        ) : (
                          <Figure>{formatCount(row.replies_human)}</Figure>
                        )}
                      </span>
                      {isUnavailable(row.replies_autoresponder) ? null : (
                        <span
                          data-testid={`replies-auto-${row.id}`}
                          className="text-[11px] text-ink-faint"
                          title="Autoresponder replies, counted separately from humans"
                        >
                          +<Figure>{formatCount(row.replies_autoresponder)}</Figure>
                        </span>
                      )}
                    </span>
                  </div>
                  {/* Hidden on phone by CSS, present in the DOM. The autoresponder
                      split already rides along with the human count above, so
                      nothing is lost at 390px. */}
                  <div className="hidden justify-end gap-4 text-[12px] sm:flex">
                    <CountCell
                      value={row.replies_autoresponder}
                      testId={`replies-auto-cell-${row.id}`}
                    />
                  </div>
                  <div className="flex justify-between gap-4 text-[12px] sm:block">
                    <span className="text-ink-muted sm:hidden">Reply rate</span>
                    <RateCell value={row.reply_rate} testId={`reply-rate-${row.id}`} />
                  </div>
                  <div className="hidden justify-end gap-4 text-[12px] sm:flex">
                    <RateCell value={row.bounce_rate} testId={`bounce-rate-${row.id}`} />
                  </div>
                  <div className="flex justify-between gap-4 text-[12px] sm:block">
                    <span className="text-ink-muted sm:hidden">Open rate</span>
                    <RateCell value={row.open_rate} testId={`open-rate-${row.id}`} />
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {hasUnreliableRate(filteredRows) ? (
            // The suppression is stated once, in full, rather than hidden in a
            // tooltip nobody on a phone will ever tap. It follows the rows on
            // screen, not every row we loaded: a note about a rate that is
            // filtered out is a claim about a figure the reader cannot see.
            <p className="border-t border-line-soft px-5 py-3 text-[11px] text-ink-faint">
              {COPY.replyRateUnreliable}
            </p>
          ) : null}
        </>
      )}
    </Card>
  )
}
