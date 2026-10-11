'use client'

import { Pill } from '@/components/dashboard/primitives'
import type { SegmentCounts } from '@/lib/segments/compile'

const n = (v: number) => v.toLocaleString('en-US')

/** Live reach: companies / contacts / verified-sendable, with a loading pulse
 *  while the debounced preview is in flight. Counts never show stale numbers
 *  silently -- `stale` dims the pill so a person can tell a count is catching up. */
export function ReachBadge({ counts, loading, error }: { counts: SegmentCounts | null; loading?: boolean; error?: string | null }) {
  if (error) return <Pill tone="bad" title={error}>Couldn’t count this yet</Pill>
  if (!counts) return <Pill tone="neutral">{loading ? 'Counting…' : 'Add a condition to see reach'}</Pill>
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${loading ? 'opacity-60' : ''}`} aria-live="polite">
      <Pill tone="accent">{n(counts.companies)} compan{counts.companies === 1 ? 'y' : 'ies'}</Pill>
      <Pill tone="neutral">{n(counts.contacts)} contact{counts.contacts === 1 ? '' : 's'}</Pill>
      <Pill tone="good">{n(counts.verified_sendable)} verified-sendable</Pill>
      {loading ? <span className="text-[11px] text-ink-faint">updating…</span> : null}
    </div>
  )
}
