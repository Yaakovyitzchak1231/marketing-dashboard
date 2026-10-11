/** The advanced-filters drawer's badge: how many conditions are active, and the live match count once one is known. Plain presentational -- no fetch, no state. */
export function FilterBadge({ activeCount, matching }: { activeCount: number; matching?: number | null }) {
  if (!activeCount) return <span className="text-[12px] text-ink-faint">Advanced filters</span>
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent-soft/60 px-2 py-0.5 text-[12px] font-medium text-ink">
      {activeCount} advanced filter{activeCount === 1 ? '' : 's'}
      {matching != null ? <span className="text-ink-faint">· {matching.toLocaleString('en-US')} matching</span> : null}
    </span>
  )
}
