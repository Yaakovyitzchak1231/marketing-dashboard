import { Card, Pill, Val } from '@/components/dashboard/primitives'
import { formatPct } from '@/components/dashboard/format'
import { SizeSparkline, type SizePoint } from './SizeSparkline'

export interface SegmentStatsData {
  segment_id: number
  history: SizePoint[]
  metrics: {
    sample_size: number
    sample_capped: boolean
    reply_rate: number | null
    meetings: number | null
    avg_score: number | null
    avg_score_field: string | null
  }
}

/** Self-contained: no page it lives on has to change to use this (another builder may
 *  be building app/segments/[id] in parallel -- see PHASE2_COMMON.md). Drop it anywhere
 *  with a loaded SegmentStatsData. */
export function SegmentStats({ data, entity }: { data: SegmentStatsData; entity: 'company' | 'contact' }) {
  const latest = data.history[data.history.length - 1]
  const prior = data.history[data.history.length - 2]
  const metric = entity === 'company' ? 'companies' : 'contacts'
  const delta = latest && prior ? latest[metric] - prior[metric] : null

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-[13px] font-semibold text-ink-muted">Size over time</h3>
          {latest ? (
            <span className="text-[12px] text-ink-faint">
              {latest[metric]} today{delta != null ? ` (${delta >= 0 ? '+' : ''}${delta} vs last snapshot)` : ''}
            </span>
          ) : null}
        </div>
        <SizeSparkline points={data.history} metric={metric} />
      </Card>

      <Card className="grid grid-cols-3 divide-x divide-line p-4 text-center">
        <div>
          <div className="text-[11px] uppercase tracking-[0.04em] text-ink-faint">Reply rate</div>
          <div className="mt-1 text-[15px] font-semibold text-ink"><Val value={data.metrics.reply_rate}>{formatPct(data.metrics.reply_rate)}</Val></div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.04em] text-ink-faint">Meetings</div>
          <div className="mt-1 text-[15px] font-semibold text-ink"><Val value={data.metrics.meetings}>{data.metrics.meetings}</Val></div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.04em] text-ink-faint">Avg score</div>
          <div className="mt-1 text-[15px] font-semibold text-ink">
            {data.metrics.avg_score_field ? <Val value={data.metrics.avg_score}>{data.metrics.avg_score?.toFixed(1)}</Val> : <Pill tone="neutral">not set up</Pill>}
          </div>
        </div>
      </Card>
      {data.metrics.sample_capped ? (
        <p className="text-[12px] text-ink-faint">Metrics are based on the first {data.metrics.sample_size.toLocaleString()} matching leads (this segment is larger).</p>
      ) : null}
    </div>
  )
}
