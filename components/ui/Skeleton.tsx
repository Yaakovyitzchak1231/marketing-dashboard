import { cn } from './cn'

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-shimmer rounded-control bg-surface-2', className)} />
}

/** A page-shaped placeholder: header, a row of stat cards, a list. */
export function PageSkeleton({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">{label}…</span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[104px] rounded-card" />
        ))}
      </div>
      <div className="space-y-2 rounded-card border border-line bg-surface p-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-5" />
        ))}
      </div>
    </div>
  )
}
