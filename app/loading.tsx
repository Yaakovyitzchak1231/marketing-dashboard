/** Neutral skeleton while a screen's server data loads. Same width as every page. */
function Block({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-card bg-line-soft ${className}`} />
}

export default function Loading() {
  return (
    <main className="mx-auto max-w-shell px-4 pb-16 pt-5 sm:px-6 sm:pt-6" aria-busy="true" aria-label="Loading">
      <Block className="h-4 w-40" />
      <Block className="mt-2 h-3 w-64" />
      <div className="mt-6 grid grid-cols-2 gap-px md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Block key={i} className="h-[84px]" />
        ))}
      </div>
      <Block className="mt-6 h-[320px] w-full" />
    </main>
  )
}
