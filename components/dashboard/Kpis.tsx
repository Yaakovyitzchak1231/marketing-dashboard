import type { Counts, Rates } from '@/lib/dashboard/types'
import { countDelta, formatCount, formatPct, rateDelta, type Delta } from './format'
import { Val } from './primitives'

interface Kpi {
  key: string
  label: string
  value: number | null
  display: string
  sub?: string
  delta: Delta | null
  help: string
}

function DeltaBadge({ delta, hasPrevious }: { delta: Delta | null; hasPrevious: boolean }) {
  if (!hasPrevious) return null
  if (!delta) return <span className="text-[11px] text-ink-faint">no prior data</span>
  const tone = delta.tone === 'good' ? 'text-good' : delta.tone === 'bad' ? 'text-bad' : 'text-ink-faint'
  const arrow = delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : ''
  return (
    <span className={`font-numeric text-[11px] font-medium ${tone}`}>
      {arrow}
      {delta.direction === 'flat' ? delta.text : delta.text.replace(/^[+-]/, '')}
      <span className="ml-1 font-sans font-normal text-ink-faint">vs prior</span>
    </span>
  )
}

export function Kpis({
  counts,
  rates,
  previous,
}: {
  counts: Counts
  rates: Rates
  previous: { counts: Counts; rates: Rates } | null
}) {
  const p = previous
  const kpis: Kpi[] = [
    {
      key: 'sent', label: 'Emails sent', value: counts.sent, display: formatCount(counts.sent),
      sub: 'all steps', delta: countDelta(counts.sent, p?.counts.sent), help: 'Every email sent in the range, including follow-up steps.',
    },
    {
      key: 'contacted', label: 'Leads contacted', value: counts.contacted, display: formatCount(counts.contacted),
      sub: 'got step 1', delta: countDelta(counts.contacted, p?.counts.contacted), help: 'Distinct leads who received their first email in the range.',
    },
    {
      key: 'reply', label: 'Reply rate', value: rates.replyRate, display: formatPct(rates.replyRate),
      sub: counts.replied != null ? `${formatCount(counts.replied)} replies` : undefined,
      delta: rateDelta(rates.replyRate, p?.rates.replyRate), help: 'Leads who replied ÷ leads contacted. Auto-replies are excluded.',
    },
    {
      key: 'positive', label: 'Positive reply rate', value: rates.positiveRate, display: formatPct(rates.positiveRate),
      sub: counts.positive != null ? `${formatCount(counts.positive)} positive` : undefined,
      delta: rateDelta(rates.positiveRate, p?.rates.positiveRate), help: 'Leads marked as interested / opportunities in Instantly ÷ leads contacted.',
    },
    {
      key: 'bounce', label: 'Bounce rate', value: rates.bounceRate, display: formatPct(rates.bounceRate),
      sub: counts.bounced != null ? `${formatCount(counts.bounced)} bounced` : undefined,
      delta: rateDelta(rates.bounceRate, p?.rates.bounceRate, false), help: 'Bounced ÷ emails sent. Keep it under 2%.',
    },
    {
      key: 'meetings', label: 'Meetings booked', value: counts.meetingsBooked, display: formatCount(counts.meetingsBooked),
      delta: countDelta(counts.meetingsBooked, p?.counts.meetingsBooked), help: 'Leads marked meeting booked in Instantly.',
    },
  ]
  return (
    <section aria-label="Key numbers">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line shadow-card md:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => (
          <div key={k.key} className="bg-surface px-4 py-3.5" data-testid={`kpi-${k.key}`} title={k.help}>
            <div className="text-[12px] text-ink-muted">{k.label}</div>
            <div className="mt-1 font-numeric text-metric text-ink">
              <Val value={k.value}>{k.display}</Val>
            </div>
            <div className="mt-1 flex min-h-[16px] flex-wrap items-baseline gap-x-2 text-[11px] text-ink-faint">
              {k.sub ? <span>{k.sub}</span> : null}
              <DeltaBadge delta={k.delta} hasPrevious={p !== null} />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** The secondary line under the KPIs: opens, clicks, unsubscribes, auto-replies. */
export function SecondaryStats({
  counts,
  rates,
  trackingOff,
}: {
  counts: Counts
  rates: Rates
  /** true = open tracking is off on every campaign, so show "tracking off" instead of a 0% open rate. */
  trackingOff: boolean
}) {
  const items: { label: string; node: React.ReactNode; title?: string }[] = [
    {
      label: 'Open rate',
      title: trackingOff ? 'Open tracking is off on every campaign, so Instantly records no opens.' : 'Unique opens ÷ leads contacted',
      node: trackingOff ? <span className="text-ink-faint">tracking off</span> : <Val value={rates.openRate}>{formatPct(rates.openRate)}</Val>,
    },
    { label: 'Click rate', node: <Val value={rates.clickRate}>{formatPct(rates.clickRate)}</Val> },
    {
      label: 'Unsubscribed',
      node: <Val value={counts.unsubscribed}>{formatCount(counts.unsubscribed)}</Val>,
    },
    {
      label: 'Auto-replies',
      title: 'Out-of-office and other automatic replies. Not counted as replies.',
      node: <Val value={counts.autoReplies}>{formatCount(counts.autoReplies)}</Val>,
    },
  ]
  return (
    <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 px-1 text-[12px]">
      {items.map((i) => (
        <div key={i.label} className="flex items-baseline gap-1.5" title={i.title}>
          <dt className="text-ink-faint">{i.label}</dt>
          <dd className="font-numeric text-ink-muted">{i.node}</dd>
        </div>
      ))}
    </dl>
  )
}
