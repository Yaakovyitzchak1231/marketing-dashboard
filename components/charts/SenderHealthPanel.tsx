import { senderHealthSummary } from '@/lib/charts'
import { formatCount, formatPercentRaw, UNAVAILABLE } from './format'
import styles from './charts.module.css'

export interface Mailbox {
  email: string
  status: string
}

interface Props {
  total: number | null
  healthy: number | null
  /** Per-mailbox detail, when the collector supplies it. */
  mailboxes?: Mailbox[]
}

const isHealthyStatus = (s: string) => /^(healthy|active|connected)$/i.test(s.trim())

/**
 * Sender health — mailbox health / deliverability per sending mailbox.
 *
 * A fleet of zero mailboxes has no health rate, and an unknown healthy count is
 * unknown. Neither renders as 0%.
 */
export function SenderHealthPanel({ total, healthy, mailboxes }: Props) {
  const summary = senderHealthSummary({ total, healthy })
  const known = summary.healthy_rate !== null

  return (
    <section className={styles.panel} data-testid="sender-health">
      <div className={styles.head}>
        <h3 className={styles.title}>Sender health</h3>
      </div>
      <p className={styles.subtitle}>Mailboxes marked healthy by Instantly</p>

      <p className={known ? styles.value : styles.unavailable}>
        {known ? formatPercentRaw(summary.healthy_rate, 0) : UNAVAILABLE}
      </p>

      {known ? (
        <>
          <p className={styles.foot}>
            {formatCount(summary.healthy)} of {formatCount(summary.total)} healthy
          </p>
          {summary.unhealthy !== null && (
            <p className={styles.foot}>{formatCount(summary.unhealthy)} unhealthy</p>
          )}
        </>
      ) : (
        <p className={styles.foot}>
          {formatCount(summary.total)} mailboxes · healthy count {UNAVAILABLE}
        </p>
      )}

      {summary.is_inconsistent && (
        <p className={styles.warn} data-testid="inconsistent-note">
          {formatCount(summary.healthy)} mailboxes marked healthy out of{' '}
          {formatCount(summary.total)} — more mailboxes marked healthy than exist. The
          sender data is inconsistent.
        </p>
      )}

      {mailboxes && mailboxes.length > 0 && (
        <div className={styles.rows} data-tabular="true">
          <div className={styles.rowHead}>Mailbox</div>
          <div className={styles.rowHead} style={{ textAlign: 'right' }}>
            Status
          </div>
          {mailboxes.map((m) => (
            <div key={m.email} style={{ display: 'contents' }}>
              <div className={`${styles.cell} ${styles.day}`}>{m.email}</div>
              <div
                className={styles.cell}
                style={{ color: isHealthyStatus(m.status) ? undefined : '#9a3412' }}
              >
                {m.status || UNAVAILABLE}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
