'use client'

import { useEffect, useState } from 'react'
import { Tooltip } from './Tooltip'

const TZ = process.env.NEXT_PUBLIC_DASHBOARD_TZ || 'America/New_York'

export function relativeLabel(d: Date, now: Date): string {
  const s = Math.round((now.getTime() - d.getTime()) / 1000)
  if (s < 0) {
    const f = -s
    if (f < 60) return `in ${f}s`
    if (f < 3600) return `in ${Math.round(f / 60)}m`
    if (f < 86400) return `in ${Math.round(f / 3600)}h`
    return `in ${Math.round(f / 86400)}d`
  }
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ })
}

export function absoluteLabel(d: Date): string {
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ })
}

/**
 * "4m ago", with the exact date and time in a tooltip (and in `title` for
 * no-JS / screen readers). Re-renders every minute. `never` when null.
 */
export function RelativeTime({ at, never = 'never', className }: { at: Date | string | null | undefined; never?: string; className?: string }) {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  if (!at) return <span className="text-ink-faint">{never}</span>
  const d = typeof at === 'string' ? new Date(at) : at
  if (Number.isNaN(d.getTime())) return <span className="text-ink-faint">{never}</span>
  const abs = absoluteLabel(d)
  // Before hydration (and in tests without timers) show the absolute time so the
  // server and client render the same text.
  const label = now ? relativeLabel(d, now) : abs
  return (
    <Tooltip content={abs}>
      <time dateTime={d.toISOString()} title={abs} className={className} suppressHydrationWarning>
        {label}
      </time>
    </Tooltip>
  )
}
