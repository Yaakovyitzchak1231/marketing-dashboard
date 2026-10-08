'use client'

import { useState } from 'react'
import type { DailyPoint } from '@/lib/dashboard/types'
import { formatCount, formatDay, NOT_REPORTED } from './format'
import { Card, EmptyNote, SectionHeader } from './primitives'

/**
 * Daily activity, as two stacked panels on one shared day axis:
 *   top    = emails sent per day (bars)
 *   bottom = replies per day, with the positive share drawn inside each bar
 * Two panels instead of one dual-axis chart: sends run in the hundreds and
 * replies in single digits, and a second y-axis makes either look like the
 * other. Each panel has its own honest scale starting at 0.
 *
 * null (Instantly did not report the day) draws nothing and is called out in
 * the readout; it is never drawn as a zero-height bar.
 */

const W = 800
const TOP_H = 120
const BOT_H = 84
const GAP = 22
/** Headroom at the top of each panel for its scale label, in viewBox units. */
const HEAD = 18
const H = TOP_H + GAP + BOT_H

/** Layout position (not a metric) as a CSS percentage. */
function toPct(fraction: number): string {
  return `${(fraction * 100).toFixed(3)}%`
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (v <= m * pow) return m * pow
  }
  return 10 * pow
}

/** Largest reported value; unreported days are skipped, not treated as 0. */
function maxOf(values: (number | null)[]): number {
  return values.reduce<number>((m, v) => (v !== null && v > m ? v : m), 0)
}

function sum(points: DailyPoint[], key: keyof DailyPoint): number | null {
  let total = 0
  let any = false
  for (const p of points) {
    const v = p[key]
    if (typeof v === 'number') {
      total += v
      any = true
    }
  }
  return any ? total : null
}

export function DailyChart({ daily }: { daily: DailyPoint[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const n = daily.length
  const hasAny = daily.some((d) => d.sent !== null || d.replied !== null)

  if (n === 0 || !hasAny) {
    return (
      <section aria-labelledby="daily-heading">
        <SectionHeader id="daily-heading" title="Daily activity" />
        <Card>
          <EmptyNote>No daily activity reported for this range.</EmptyNote>
        </Card>
      </section>
    )
  }

  const sentMax = niceMax(maxOf(daily.map((d) => d.sent)))
  const replyMax = niceMax(maxOf(daily.map((d) => d.replied)))
  const slot = W / n
  const barW = Math.max(1, Math.min(28, slot * 0.68))
  const x = (i: number) => i * slot + (slot - barW) / 2
  const botTop = TOP_H + GAP
  const labelEvery = Math.max(1, Math.ceil(n / 6))
  const focus = hover ?? n - 1
  const f = daily[focus]

  const totals = {
    sent: sum(daily, 'sent'),
    replied: sum(daily, 'replied'),
    positive: sum(daily, 'positive'),
  }

  return (
    <section aria-labelledby="daily-heading">
      <SectionHeader
        id="daily-heading"
        title="Daily activity"
        meta={
          <span className="flex items-center gap-3">
            <Legend swatch="bg-ink/70" label="Sent" />
            <Legend swatch="bg-accent/45" label="Replies" />
            <Legend swatch="bg-accent" label="Positive" />
          </span>
        }
      />
      <Card className="px-3 pb-2 pt-3 sm:px-4">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 px-1 text-[12px]" aria-live="polite">
          <span className="font-medium text-ink">{f ? formatDay(f.date) : ''}</span>
          <Readout label="sent" v={f ? f.sent : null} />
          <Readout label="replies" one="reply" v={f ? f.replied : null} />
          <Readout label="positive" v={f ? f.positive : null} />
          <span className="ml-auto text-ink-faint">
            Range total: {formatCount(totals.sent)} sent · {formatCount(totals.replied)} replies · {formatCount(totals.positive)} positive
          </span>
        </div>
        <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-[200px] w-full touch-none select-none sm:h-[220px]"
          role="img"
          aria-label={`Daily emails sent and replies, ${formatDay(daily[0].date)} to ${formatDay(daily[n - 1].date)}`}
          onMouseLeave={() => setHover(null)}
        >
          {/* gridlines + max labels */}
          <line x1={0} x2={W} y1={0.5} y2={0.5} className="stroke-line-soft" vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={W} y1={TOP_H - 0.5} y2={TOP_H - 0.5} className="stroke-line" vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={W} y1={botTop + 0.5} y2={botTop + 0.5} className="stroke-line-soft" vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={W} y1={botTop + BOT_H - 0.5} y2={botTop + BOT_H - 0.5} className="stroke-line" vectorEffect="non-scaling-stroke" />

          {daily.map((d, i) => {
            const sentH = d.sent === null ? 0 : (d.sent / sentMax) * (TOP_H - HEAD)
            const repH = d.replied === null ? 0 : (d.replied / replyMax) * (BOT_H - HEAD)
            const posH =
              d.positive === null || d.replied === null
                ? 0
                : (Math.min(d.positive, d.replied) / replyMax) * (BOT_H - HEAD)
            const dim = hover !== null && hover !== i
            return (
              <g key={d.date} opacity={dim ? 0.45 : 1}>
                {d.sent !== null ? (
                  <rect x={x(i)} y={TOP_H - sentH} width={barW} height={Math.max(sentH, d.sent > 0 ? 1 : 0)} className="fill-ink/70" />
                ) : null}
                {d.replied !== null ? (
                  <rect x={x(i)} y={botTop + BOT_H - repH} width={barW} height={Math.max(repH, d.replied > 0 ? 1 : 0)} className="fill-accent/45" />
                ) : null}
                {posH > 0 ? (
                  <rect x={x(i)} y={botTop + BOT_H - posH} width={barW} height={posH} className="fill-accent" />
                ) : null}
                {/* full-height hit area */}
                <rect
                  x={i * slot}
                  y={0}
                  width={slot}
                  height={TOP_H + GAP + BOT_H}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onTouchStart={() => setHover(i)}
                >
                  <title>{`${formatDay(d.date)}: ${formatCount(d.sent)} sent, ${formatCount(d.replied)} replies, ${formatCount(d.positive)} positive`}</title>
                </rect>
              </g>
            )
          })}
        </svg>
          <span className="pointer-events-none absolute left-1 top-1 text-[10px] text-ink-faint">
            Sent · scale {formatCount(sentMax)}/day
          </span>
          <span
            className="pointer-events-none absolute left-1 text-[10px] text-ink-faint"
            style={{ top: `calc(${toPct(botTop / H)} + 3px)` }}
          >
            Replies · scale {formatCount(replyMax)}/day
          </span>
        </div>
        <div className="relative mt-1 h-4" aria-hidden>
          {daily.map((d, i) =>
            (i % labelEvery === 0 && n - 1 - i >= labelEvery / 2) || i === n - 1 ? (
              <span
                key={d.date}
                className="absolute top-0 whitespace-nowrap text-[10px] text-ink-faint"
                style={
                  i === n - 1
                    ? { right: 0 }
                    : i === 0
                      ? { left: 0 }
                      : { left: toPct((i + 0.5) / n), transform: 'translateX(-50%)' }
                }
              >
                {formatDay(d.date)}
              </span>
            ) : null,
          )}
        </div>
      </Card>
    </section>
  )
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-ink-muted">
      <span className={`inline-block h-2 w-2 rounded-[1px] ${swatch}`} aria-hidden />
      {label}
    </span>
  )
}

function Readout({ label, one, v }: { label: string; one?: string; v: number | null }) {
  return (
    <span className="text-ink-muted">
      <span className="font-numeric text-ink">
        {v === null ? (
          <span className="text-unavailable" title={NOT_REPORTED}>—</span>
        ) : (
          formatCount(v)
        )}
      </span>{' '}
      {v === 1 && one ? one : label}
    </span>
  )
}
