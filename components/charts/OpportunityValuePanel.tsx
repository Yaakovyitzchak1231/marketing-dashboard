import { opportunityValueSummary } from '@/lib/charts'
import { formatCount, formatCurrency, UNAVAILABLE } from './format'
import styles from './charts.module.css'

interface Props {
  openValue: number | null
  openCount: number | null
  /** Total value of all opportunities, if known. Needed before closed value can be shown. */
  totalValue?: number | null
}

/**
 * Opportunity value — its own dimension.
 *
 * This is open pipeline value, and it is labelled that way. It is not revenue and
 * is never summed with, or relabelled as, revenue.
 */
export function OpportunityValuePanel({ openValue, openCount, totalValue }: Props) {
  const summary = opportunityValueSummary({ openValue, openCount, totalValue })
  const known = summary.open_value !== null

  return (
    <section className={styles.panel} data-testid="opportunity-value">
      <div className={styles.head}>
        <h3 className={styles.title}>Opportunity value</h3>
      </div>
      <p className={styles.subtitle}>Open pipeline value</p>

      <p className={known ? styles.value : styles.unavailable}>
        {known ? formatCurrency(summary.open_value) : UNAVAILABLE}
      </p>

      {known && summary.open_count !== null && (
        <p className={styles.foot}>{formatCount(summary.open_count)} open</p>
      )}

      <p className={styles.foot}>
        {summary.value_per_opportunity === null
          ? UNAVAILABLE
          : `${formatCurrency(summary.value_per_opportunity)} average`}
      </p>

      {summary.closed_value !== null && (
        <p className={styles.foot}>{formatCurrency(summary.closed_value)} closed</p>
      )}
    </section>
  )
}

/** Compact variant used inside a KPI row, where the panel chrome would be noise. */
export function OpportunityValueInline({
  openValue,
  openCount,
}: {
  openValue: number | null
  openCount: number | null
}) {
  const summary = opportunityValueSummary({ openValue, openCount })
  return (
    <span>
      {summary.open_value === null
        ? UNAVAILABLE
        : `${formatCurrency(summary.open_value)} open pipeline`}
    </span>
  )
}
