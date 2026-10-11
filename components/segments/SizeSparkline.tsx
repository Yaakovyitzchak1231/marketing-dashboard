/**
 * A tiny inline SVG sparkline for one segment's size history. No chart
 * library (none is in package.json, and the common brief says no new
 * dependency without asking first) -- this is ~15 points at most (one per
 * day, 90-day window), which is nothing to hand-draw.
 */
export interface SizePoint {
  taken_on: string
  companies: number
  contacts: number
  sendable: number
}

export function SizeSparkline({ points, metric = 'companies', width = 240, height = 48 }: { points: SizePoint[]; metric?: 'companies' | 'contacts' | 'sendable'; width?: number; height?: number }) {
  if (points.length === 0) {
    return <div className="flex h-12 items-center text-[12px] text-ink-faint">No snapshots yet -- the daily job hasn&apos;t run on this segment.</div>
  }
  const values = points.map((p) => p[metric])
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = Math.max(max - min, 1)
  const stepX = points.length > 1 ? width / (points.length - 1) : 0
  const coords = values.map((v, i) => {
    const x = points.length > 1 ? i * stepX : width / 2
    const y = height - ((v - min) / span) * (height - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const path = `M${coords.join(' L')}`
  const last = values[values.length - 1]
  const first = values[0]
  const trend = last > first ? 'good' : last < first ? 'bad' : 'neutral'
  const strokeClass = trend === 'good' ? 'stroke-good' : trend === 'bad' ? 'stroke-bad' : 'stroke-ink-faint'
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metric} over time, from ${first} to ${last}`}>
      <path d={path} fill="none" className={strokeClass} strokeWidth={1.5} />
      {coords.length > 0 ? <circle cx={coords[coords.length - 1].split(',')[0]} cy={coords[coords.length - 1].split(',')[1]} r={2.5} className={trend === 'good' ? 'fill-good' : trend === 'bad' ? 'fill-bad' : 'fill-ink-faint'} /> : null}
    </svg>
  )
}
