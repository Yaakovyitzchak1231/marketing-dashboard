/**
 * A lead's event timeline: lp.lead_events, newest first, with a category
 * filter and a plain-text search over the event's label/campaign/type (plan
 * 2.10). filterEvents is exported on its own so it can be unit-tested without
 * rendering anything.
 */
import { EmptyNote } from '@/components/dashboard/primitives'
import type { LeadEventRow } from '@/lib/leads/detail'

/** Fallback when an event's type has no registered label (shouldn't normally happen). */
function fallbackLabel(type: string): string {
  return type.replace(/_/g, ' ')
}

export function eventLabel(e: LeadEventRow): string {
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

export const TIMELINE_CATEGORIES = ['email', 'lifecycle', 'verification', 'web', 'social', 'meeting', 'deal', 'signal', 'custom'] as const

/** Pure filter: category (exact match on lp.event_types.category) and a plain-text
 *  search over the event's label, raw type, and campaign name. Both optional. */
export function filterEvents(events: LeadEventRow[], opts: { category?: string | null; q?: string | null } = {}): LeadEventRow[] {
  const category = opts.category?.trim() || null
  const needle = opts.q?.trim().toLowerCase() || null
  return events.filter((e) => {
    if (category && e.category !== category) return false
    if (needle) {
      const hay = `${eventLabel(e)} ${e.type} ${e.campaign_name ?? ''}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })
}

export function TimelineFilters({ category, q }: { category: string | null; q: string | null }) {
  return (
    <form method="get" className="mb-3 flex flex-wrap items-center gap-2 text-xs">
      {/* Keep the Timeline tab open on submit (review fix, #79: it used to jump back to Overview). */}
      <input type="hidden" name="tab" value="timeline" />
      <select
        name="tl_cat"
        defaultValue={category ?? ''}
        className="rounded-control border border-line bg-canvas px-2 py-1 text-ink"
      >
        <option value="">All categories</option>
        {TIMELINE_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <input
        type="search"
        name="tl_q"
        defaultValue={q ?? ''}
        placeholder="Search timeline…"
        className="min-w-[160px] flex-1 rounded-control border border-line bg-canvas px-2 py-1 text-ink"
      />
      <button type="submit" className="rounded-control border border-line px-2 py-1 text-ink-muted hover:text-ink">
        Filter
      </button>
      {category || q ? (
        <a href="?tab=timeline" className="text-ink-faint underline-offset-2 hover:underline">
          Clear
        </a>
      ) : null}
    </form>
  )
}

export function LeadTimeline({ events }: { events: LeadEventRow[] }) {
  if (!events.length) return <EmptyNote>No events match.</EmptyNote>
  return (
    <ol className="divide-y divide-line-soft">
      {events.map((e) => (
        <li key={e.id} className="px-4 py-2.5 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="min-w-0 font-medium text-ink [overflow-wrap:anywhere]">{eventLabel(e)}</span>
            <span className="text-xs tabular-nums text-ink-faint" title={new Date(e.occurred_at).toLocaleString('en-US')}>
              {relativeTime(e.occurred_at)}
            </span>
          </div>
          {e.campaign_name ? <div className="text-xs text-ink-faint [overflow-wrap:anywhere]">{e.campaign_name}</div> : null}
        </li>
      ))}
    </ol>
  )
}
