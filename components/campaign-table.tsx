import { formatCount, formatRate, formatDate, isUnavailable, UNAVAILABLE } from '@/lib/format'
import { Card, SectionLabel, Figure, Unavailable } from '@/components/primitives'

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
 * A reply rate above 100% is not a result -- it is the autoresponder bug
 * (333%, 450%) surfacing again. Presenting it as a measurement is worse than
 * presenting nothing, so it is labelled as unreliable and the raw counts
 * beside it are what the reader gets.
 */
function rateIsImplausible(value: number | null): boolean {
  return !isUnavailable(value) && value > 1
}

function RateCell({
  value,
  testId,
}: {
  value: number | null
  testId?: string
}) {
  if (rateIsImplausible(value)) {
    return (
      <span data-testid={testId} className="whitespace-nowrap text-warn">
        Not reliable
      </span>
    )
  }
  if (isUnavailable(value)) return <Unavailable testId={testId} />
  return <Figure>{formatRate(value)}</Figure>
}

function CountCell({ value, testId }: { value: number | null; testId?: string }) {
  if (isUnavailable(value)) return <Unavailable testId={testId} />
  return (
    <span data-testid={testId}>
      <Figure>{formatCount(value)}</Figure>
    </span>
  )
}

const HEADERS: { label: string; align: 'left' | 'right' }[] = [
  { label: 'Campaign', align: 'left' },
  { label: 'Sent', align: 'right' },
  { label: 'Replies (human)', align: 'right' },
  { label: 'Auto', align: 'right' },
  { label: 'Reply rate', align: 'right' },
  { label: 'Bounce rate', align: 'right' },
  { label: 'Open rate', align: 'right' },
]

export function CampaignTable({ rows }: { rows: CampaignRow[] }) {
  const isEmpty = rows.length === 0

  return (
    <Card className="overflow-hidden">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3">
        <SectionLabel>Campaigns</SectionLabel>
        {rows.length > 0 ? (
          <span className="text-[11px] text-ink-faint">
            {formatCount(rows.length)} shown
          </span>
        ) : null}
      </div>

      {isEmpty ? (
        // First-run state. A deliberate, empty table reads as "nothing here
        // yet"; a crash or a spinner here would read as "broken".
        <div
          data-testid="campaign-table-empty"
          className="px-5 py-10 text-center text-[13px] text-ink-faint"
        >
          No campaigns have reported metrics in this range yet.
        </div>
      ) : (
        <>
          {/* Desktop: a real table. Phone: a stacked list, because a 7-column
              table at 390px is unreadable no matter how it is scrolled. */}
          <table
            data-testid="campaign-table"
            className="hidden w-full border-collapse text-[13px] sm:table"
          >
            <thead>
              <tr className="border-b border-line">
                {HEADERS.map((h) => (
                  <th
                    key={h.label}
                    scope="col"
                    className={`px-5 py-2 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted ${
                      h.align === 'right' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line-soft last:border-b-0">
                  <th scope="row" className="px-5 py-2.5 text-left font-normal">
                    <span className="block truncate font-medium text-ink">{row.name}</span>
                    <span className="block text-[11px] text-ink-faint">
                      {row.status ?? 'status unknown'}
                      {row.metric_date ? ` · ${formatDate(row.metric_date)}` : ''}
                    </span>
                  </th>
                  <td className="px-5 py-2.5 text-right">
                    <CountCell value={row.emails_sent} testId={`emails-sent-${row.id}`} />
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <CountCell value={row.replies_human} testId={`replies-human-${row.id}`} />
                  </td>
                  <td className="px-5 py-2.5 text-right text-ink-muted">
                    <CountCell
                      value={row.replies_autoresponder}
                      testId={`replies-auto-${row.id}`}
                    />
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <RateCell value={row.reply_rate} testId={`reply-rate-${row.id}`} />
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <RateCell value={row.bounce_rate} />
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <RateCell value={row.open_rate} testId={`open-rate-${row.id}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Phone: same data, stacked. Nothing is dropped -- a mobile reader
              still sees the human/autoresponder split. */}
          <ul data-testid="campaign-list" className="divide-y divide-line-soft sm:hidden">
            {rows.map((row) => (
              <li key={row.id} className="px-5 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[13px] font-medium text-ink">{row.name}</span>
                  <span className="shrink-0 text-[11px] text-ink-faint">
                    {row.status ?? 'status unknown'}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
                  <div className="flex justify-between">
                    <dt className="text-ink-muted">Sent</dt>
                    <dd>
                      <CountCell value={row.emails_sent} testId={`m-emails-sent-${row.id}`} />
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-muted">Replies</dt>
                    <dd>
                      <span data-testid={`m-replies-human-${row.id}`}>
                        {isUnavailable(row.replies_human) ? (
                          <Unavailable />
                        ) : (
                          <Figure>
                            {formatCount(row.replies_human)}
                            {isUnavailable(row.replies_autoresponder) ? '' : (
                              <span className="text-ink-faint">
                                {' '}
                                +{formatCount(row.replies_autoresponder)} auto
                              </span>
                            )}
                          </Figure>
                        )}
                      </span>
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-muted">Reply rate</dt>
                    <dd>
                      <RateCell value={row.reply_rate} />
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink-muted">Open rate</dt>
                    <dd>
                      <RateCell value={row.open_rate} />
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  )
}
