import type { DeliveryStatus } from '@/lib/notify/deliver'

const LABEL: Record<DeliveryStatus, { text: string; cls: string; title: string }> = {
  read: { text: 'read', cls: 'text-good', title: 'They opened it' },
  delivered: { text: 'delivered', cls: 'text-good', title: 'Their channel confirmed it arrived' },
  sent: { text: 'sent', cls: 'text-ink-muted', title: 'Sent; waiting for them to confirm' },
  held: { text: 'held for Shabbos', cls: 'text-ink-muted', title: 'Quiet hours; goes out after nightfall' },
  pending: { text: 'sending…', cls: 'text-ink-muted', title: 'Going out now (or retrying)' },
  failed: { text: 'failed', cls: 'text-bad', title: 'Could not be delivered after retries' },
  no_channel: { text: 'not connected', cls: 'text-warn', title: 'This agent has no way to hear about it yet: add a channel on its page' },
}

export function DeliveryChip({ status, error, human }: { status: DeliveryStatus; error?: string | null; human?: boolean }) {
  const l = status === 'no_channel' && human ? { text: 'on the dashboard', cls: 'text-ink-muted', title: 'Shows live in the dashboard inbox' } : LABEL[status]
  return (
    <span className={`whitespace-nowrap text-[11px] font-medium ${l.cls}`} title={error ? `${l.title}: ${error}` : l.title}>
      {l.text}
      {status === 'failed' && error ? <span className="font-normal"> · {error.slice(0, 80)}</span> : null}
    </span>
  )
}
