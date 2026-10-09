/**
 * Shown while the fast first round of calls (totals, deltas, the campaign list)
 * is in flight. Once that answers, this whole skeleton is replaced by the real
 * page and each remaining section streams into its own placeholder.
 */
function Block({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-card bg-line-soft ${className}`} />
}

export default function Loading() {
  return (
    <div className="min-h-screen" aria-busy="true" aria-label="Loading dashboard">
      <div>
        <div className="mx-auto flex max-w-shell flex-col gap-3 px-4 pt-5 sm:flex-row sm:items-end sm:justify-between sm:px-6 sm:pt-6">
          <div>
            <div className="text-[15px] font-semibold text-ink">Campaigns</div>
            <div className="mt-0.5 text-[12px] text-ink-faint">Loading live numbers from Instantly…</div>
          </div>
          <Block className="h-8 w-[260px]" />
        </div>
      </div>
      <div className="mx-auto flex max-w-shell flex-col gap-8 px-4 pt-6 sm:px-6">
        <div className="grid grid-cols-2 gap-px md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Block key={i} className="h-[92px]" />
          ))}
        </div>
        <div className="space-y-3">
          <Block className="h-3 w-32" />
          <Block className="h-[220px] w-full" />
        </div>
        <Block className="h-[260px] w-full" />
        <Block className="h-[300px] w-full" />
      </div>
    </div>
  )
}
