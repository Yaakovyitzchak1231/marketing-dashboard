import { buildReplyTrend, type TrendDayInput } from '@/lib/charts'
import { ReplyTrendChart } from './ReplyTrendChart'
import { OpportunityValuePanel } from './OpportunityValuePanel'
import { SenderHealthPanel } from './SenderHealthPanel'

/** One daily row as the API returns it. Counts may be null. */
export interface ApiTrendRow {
  metric_date: string
  emails_sent: number | null
  replies_human: number | null
  replies_autoresponder: number | null
}

/**
 * Adapter from the API's trend rows to the chart's input shape.
 *
 * It maps explicitly and does no arithmetic — every rate is computed inside
 * `buildReplyTrend` from raw counts. There is deliberately no `?? 0` here: a day
 * the API did not report stays missing so the chart can break the line there.
 */
export function trendFromApiRows(rows: ApiTrendRow[]): TrendDayInput[] {
  if (!Array.isArray(rows)) return []
  return rows.map((r) => ({
    metric_date: r.metric_date,
    emails_sent: r.emails_sent ?? null,
    replies_human: r.replies_human ?? null,
    replies_autoresponder: r.replies_autoresponder ?? null,
  }))
}

interface Props {
  trendRows: ApiTrendRow[]
  openValue: number | null
  openCount: number | null
  totalValue?: number | null
  mailboxTotal: number | null
  mailboxHealthy: number | null
}

/**
 * The chart block. Split out from the page so the page (owned by the shell task)
 * composes it, and so these three charts can be verified in isolation.
 *
 * The grid is intrinsic-width aware so it collapses to one column on a phone
 * instead of overflowing at 390px.
 */
export function ChartsBlock({
  trendRows,
  openValue,
  openCount,
  totalValue,
  mailboxTotal,
  mailboxHealthy,
}: Props) {
  const trend = buildReplyTrend(trendFromApiRows(trendRows))

  return (
    <div
      style={{
        display: 'grid',
        gap: 16,
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
      }}
    >
      <ReplyTrendChart points={trend.points} showOpenRate />
      <OpportunityValuePanel
        openValue={openValue}
        openCount={openCount}
        totalValue={totalValue}
      />
      <SenderHealthPanel total={mailboxTotal} healthy={mailboxHealthy} />
    </div>
  )
}
