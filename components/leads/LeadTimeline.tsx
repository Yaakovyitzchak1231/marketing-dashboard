/**
 * A lead's event timeline: lp.lead_events, newest first. Plain labels (no
 * icons), the campaign name when the event has one, and relative time.
 */
import { EmptyNote } from '@/components/dashboard/primitives'
import type { LeadEventRow } from '@/lib/leads/detail'

/** Fallback when an event's type has no registered label (shouldn't normally happen). */
function fallbackLabel(type: string): string {
  return type.replace(/_/g, ' ')
}

function eventLabel(e: LeadEventRow): string {
  if (e.type === 'custom' && typeof e.props?.instantly_type === 'string') {
    return fallbackLabel(e.props.instantly_type)
  }
  return e.type_label ?? fallbackLabel(e.type)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now" / "12m ago" / "3h ago" / "5d ago" / a short date past a month. */
export function relativeTime(d: Date | string, now: Date = new Date()): string {
  const t = new Date(d).getTime()
  const diff = now.getTime() - t
  if (!Number.isFinite(diff)) return '—'
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d ago`
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function LeadTimeline({ events }: { events: LeadEventRow[] }) {
  if (!events.length) return <EmptyNote>No events yet.</EmptyNote>
  return (
    <ol className="divide-y divide-line-soft">
      {events.map((e) => (
        <li key={e.id} className="px-4 py-2.5 text-[13px]">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium text-ink">{eventLabel(e)}</span>
            <span className="text-[12px] tabular-nums text-ink-faint" title={new Date(e.occurred_at).toLocaleString('en-US')}>
              {relativeTime(e.occurred_at)}
            </span>
          </div>
          {e.campaign_name ? <div className="text-[12px] text-ink-faint">{e.campaign_name}</div> : null}
        </li>
      ))}
    </ol>
  )
}
