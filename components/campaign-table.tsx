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
}: {
  rows: CampaignRow[]
  /**
   * The full count the source knows about. When it exceeds `rows.length` the
   * list is truncated and we say so out loud (COPY.partialList). Omit it when
   * the source did not report a total.
   */
  total?: number | null
}) {
  const isEmpty = rows.length === 0
  const isPartial = !isUnavailable(total) && (total as number) > rows.length

  return (
    <Card testId="campaign-table" className="overflow-hidden">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3">
        <SectionLabel>Campaigns</SectionLabel>
        {isPartial ? (
          // A silently short list is the bug this project was built to fix.
          <span className="text-[11px] text-warn">
            {COPY.partialList(rows.length, total as number)}
          </span>
        ) : rows.length > 0 ? (
          <span className="text-[11px] text-ink-faint">
            <Figure>{formatCount(rows.length)}</Figure> shown
          </span>
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

          <ul className="divide-y divide-line-soft">
            {rows.map((row) => (
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

          {hasUnreliableRate(rows) ? (
            // The suppression is stated once, in full, rather than hidden in a
            // tooltip nobody on a phone will ever tap.
            <p className="border-t border-line-soft px-5 py-3 text-[11px] text-ink-faint">
              {COPY.replyRateUnreliable}
            </p>
          ) : null}
        </>
      )}
    </Card>
  )
}
