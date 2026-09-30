import { buildLinePath, buildScale, type TrendPoint } from '@/lib/charts'
import { COPY } from '@/lib/copy'
import { EM_DASH, formatCell, formatDay, formatPercent, formatPercentRaw } from './format'
import styles from './charts.module.css'

interface Props {
  points: TrendPoint[]
  /** Render the open-rate row, which is permanently unavailable. */
  showOpenRate?: boolean
}

const W = 640
const H = 160
const PAD = 6

/**
 * Daily human reply rate.
 *
 * The series is `replies_human / emails_sent` per day — the autoresponder-free
 * count that keeps the 333%/450% figures out. The line is broken wherever a day is
 * missing, because a day we do not have is not a zero and a straight edge across it
 * would invent a measurement.
 */
export function ReplyTrendChart({ points, showOpenRate = false }: Props) {
  const known = points.filter((p) => p.reply_rate !== null)
  const anyUnreliable = points.some((p) => p.unreliable)

  // No history is a first-run state, not a failure and not an empty box.
  if (points.length === 0) {
    return (
      <section className={styles.panel}>
        <h3 className={styles.title}>Human reply rate</h3>
        <p className={styles.subtitle}>Human replies only, autoresponders excluded</p>
        <div className={styles.empty}>{COPY.trendEmpty}</div>
      </section>
    )
  }

  const xs = points.map((_, i) => i)
  const ys = points.map((p) => p.reply_rate)
  const scale = buildScale(known.map((p) => p.reply_rate as number), {
    width: W,
    height: H,
    padding: PAD,
  })
  const path = buildLinePath(
    xs,
    ys.map((y) => (y === null ? null : scale.y(y))),
    { width: W, height: H, padding: PAD },
  )

  return (
    <section className={styles.panel} data-testid="reply-trend">
      <div className={styles.head}>
        <h3 className={styles.title}>Human reply rate</h3>
        <p className={styles.subtitle} style={{ margin: 0 }}>
          Human replies only, autoresponders excluded
        </p>
      </div>

      {known.length > 1 && (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          role="img"
          aria-label="Daily human reply rate"
          style={{ display: 'block', overflow: 'visible' }}
        >
          <path
            data-series="reply-rate"
            d={path}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {known.map((p) => {
            const i = points.indexOf(p)
            return (
              <circle
                key={p.metric_date}
                cx={PAD + (i / Math.max(1, xs.length - 1)) * (W - PAD * 2)}
                cy={scale.y(p.reply_rate as number)}
                r={2.5}
                fill="var(--accent)"
              />
            )
          })}
        </svg>
      )}

      {anyUnreliable && (
        <p className={styles.warn} data-testid="unreliable-note">
          {COPY.replyRateUnreliable}
        </p>
      )}

      {/* The data is a table too, so every number is readable without hovering and
          the chart is never the only way to check it. */}
      <div className={styles.rows} data-tabular="true">
        <div className={styles.rowHead}>Day</div>
        <div className={styles.rowHead} style={{ textAlign: 'right' }}>Sent</div>
        <div className={styles.rowHead} style={{ textAlign: 'right' }}>Replies</div>
        <div className={styles.rowHead} style={{ textAlign: 'right' }}>Rate</div>

        {points.map((p) => (
          <div key={p.metric_date} style={{ display: 'contents' }}>
            <div className={`${styles.cell} ${styles.day}`}>{p.metric_date}</div>
            <div className={styles.cell}>{formatCell(p.emails_sent)}</div>
            <div className={styles.cell}>{formatCell(p.replies_human)}</div>
            <div className={`${styles.cell} ${p.unreliable ? styles.unreliable : ''}`}>
              {p.unreliable ? formatPercentRaw(p.reply_rate) : formatPercent(p.reply_rate)}
            </div>
          </div>
        ))}

        {showOpenRate && (
          <div style={{ display: 'contents' }}>
            <div className={`${styles.cell} ${styles.day}`}>Open rate</div>
            <div className={`${styles.cell} ${styles.unavailable}`} style={{ gridColumn: 'span 3' }}>
              {COPY.metricUnavailable}
            </div>
          </div>
        )}
      </div>

      {points.length === 1 && (
        <p className={styles.foot}>One day collected so far</p>
      )}
    </section>
  )
}
