import type { CampaignRow, DateRange } from '@/lib/dashboard/types'

/** Calendar days covered by the range (inclusive), or null for open-ended ranges. */
export function rangeDays(range: DateRange, dailyLength: number): number | null {
  if (range.start) {
    const s = Date.parse(`${range.start}T00:00:00Z`)
    const e = Date.parse(`${range.end}T00:00:00Z`)
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) return Math.round((e - s) / 86_400_000) + 1
  }
  return dailyLength > 0 ? dailyLength : null
}

/** "this period" wording for detail lines. */
export function periodLabel(range: DateRange): string {
  switch (range.key) {
    case '7d': return 'the last 7 days'
    case '14d': return 'the last 14 days'
    case '30d': return 'the last 30 days'
    case '90d': return 'the last 90 days'
    case 'all': return 'your full history'
    default: return 'this period'
  }
}

/** "the previous 30 days" wording for trend lines. */
export function previousLabel(range: DateRange): string {
  switch (range.key) {
    case '7d': return 'the 7 days before'
    case '14d': return 'the 14 days before'
    case '30d': return 'the 30 days before'
    case '90d': return 'the 90 days before'
    default: return 'the period before'
  }
}

/** YYYY-MM-DD for an instant in an IANA timezone (falls back to UTC on a bad zone). */
export function localDate(iso: string, timezone: string): string | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t))
  try {
    return fmt(timezone)
  } catch {
    return fmt('UTC')
  }
}

/** "2026-10-05" -> "Oct 5". */
export function shortDate(ymd: string): string {
  const t = Date.parse(`${ymd}T00:00:00Z`)
  if (!Number.isFinite(t)) return ymd
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(t))
}

/** Did the campaign do anything in the range? Unknown (all null) counts as no evidence of activity. */
export function activeInRange(c: CampaignRow): boolean {
  return (c.counts.sent ?? 0) > 0 || (c.counts.contacted ?? 0) > 0
}

export function campaignEntity(c: CampaignRow) {
  return { kind: 'campaign' as const, id: c.id, name: c.name }
}

/** Quote a campaign name for prose. */
export function q(name: string): string {
  return `“${name}”`
}
