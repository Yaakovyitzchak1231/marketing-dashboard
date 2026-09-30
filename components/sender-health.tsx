import { formatCount, formatRate, isUnavailable } from '@/lib/format'
import { Card, SectionLabel, Figure, Unavailable } from '@/components/primitives'

/**
 * Sender health -- the deliverability layer. A portfolio reply rate means
 * little if the mailboxes behind it are cold or disconnected, so this panel
 * is a first-class section rather than a footnote.
 *
 * Field names mirror the `accounts` columns from T3's schema.
 */
export type SenderHealth = {
  mailbox_count: number | null
  healthy_mailboxes: number | null
  warmup_avg: number | null
  daily_limit: number | null
  setup_pending: number | null
}

/**
 * The unhealthy count is derived as a remainder, never stored separately: a
 * disconnected mailbox is `total - healthy`. If either input is missing the
 * remainder is unknown too, so it renders as a dash rather than as the total
 * (which would read as "everything is broken") or as a zero.
 */
function unhealthyCount(h: SenderHealth): number | null {
  if (isUnavailable(h.mailbox_count) || isUnavailable(h.healthy_mailboxes)) return null
  return h.mailbox_count - h.healthy_mailboxes
}

function Stat({
  label,
  children,
  testId,
}: {
  label: string
  children: React.ReactNode
  testId?: string
}) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <div className="text-[11px] text-ink-muted">{label}</div>
      <div className="mt-0.5 text-[15px] font-medium text-ink">{children}</div>
    </div>
  )
}

export function SenderHealthPanel({ health }: { health: SenderHealth }) {
  const unhealthy = unhealthyCount(health)
  const known = !isUnavailable(health.mailbox_count) && !isUnavailable(health.healthy_mailboxes)

  return (
    <Card className="px-5 py-4">
      <SectionLabel>Sending health</SectionLabel>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
        <Stat label="Mailboxes" testId="mailbox-count">
          {isUnavailable(health.mailbox_count) ? <Unavailable /> : <Figure>{formatCount(health.mailbox_count)}</Figure>}
        </Stat>
        <Stat label="Healthy" testId="healthy-count">
          {isUnavailable(health.healthy_mailboxes) ? (
            <Unavailable />
          ) : (
            <Figure>{formatCount(health.healthy_mailboxes)}</Figure>
          )}
        </Stat>
        <Stat label="Not healthy" testId="unhealthy-count">
          {isUnavailable(unhealthy) ? (
            <Unavailable />
          ) : (
            // Zero here is a genuinely good state: every mailbox is healthy.
            <Figure className={unhealthy === 0 ? 'text-ink-faint' : undefined}>
              {formatCount(unhealthy)}
            </Figure>
          )}
        </Stat>
        <Stat label="Avg warmup" testId="warmup-avg">
          {isUnavailable(health.warmup_avg) ? <Unavailable /> : <Figure>{formatRate(health.warmup_avg / 100)}</Figure>}
        </Stat>
      </div>
      {known ? null : (
        <p className="mt-3 border-t border-line-soft pt-3 text-[11px] text-ink-faint">
          Mailbox inventory has not been reported for this range.
        </p>
      )}
    </Card>
  )
}
