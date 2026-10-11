/**
 * How a secret is described on screen: its last 4 characters and when it was
 * set — never the value. Pure functions, no server-only imports, so both the
 * settings store (server) and SecretField / the agents panel (client or
 * server) use the same words.
 */
/** Values shorter than this show no characters at all ("…" only): 4 of 7 would be most of it. */
export const MIN_LEN_FOR_LAST4 = 12

/** The last 4 characters of a secret, or null when it is empty or too short to show any part of safely. Never more than 4 characters. */
export function last4Of(value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  if (v.length < MIN_LEN_FOR_LAST4) return null
  return v.slice(-4)
}

/** "…1234", or "…" when there is nothing safe to show. A stored hint longer than 4 is cut to its last 4. */
export function maskedTail(last4: string | null | undefined): string {
  const t = (last4 ?? '').trim()
  return t ? `…${t.slice(-4)}` : '…'
}

/** "Oct 11, 2026, 9:56 AM" in the given timezone (falls back to the runtime's own zone if the name is bad). Null in, null out. */
export function formatSetAt(at: string | Date | null | undefined, timeZone?: string): string | null {
  if (at === null || at === undefined || at === '') return null
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return null
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
  try {
    return d.toLocaleString('en-US', timeZone ? { ...opts, timeZone } : opts)
  } catch {
    return d.toLocaleString('en-US', opts)
  }
}

export interface SecretSummaryInput {
  /** 'db' = saved on /settings, 'env' = from the deployment's env var, 'unset' = neither. */
  source: 'db' | 'env' | 'unset'
  last4: string | null
  /** When it was saved (db) or first seen by the dashboard (env). */
  at: string | Date | null
  by?: string | null
  timeZone?: string
}

/** The badge and the small line under it, e.g. {badge: "Set · …1234", line: "Set Oct 11, 2026, 9:56 AM by owner"}. */
export function secretSummary(i: SecretSummaryInput): { badge: string; line: string | null } {
  const when = formatSetAt(i.at, i.timeZone)
  if (i.source === 'db') {
    return { badge: `Set · ${maskedTail(i.last4)}`, line: `Set ${when ?? '(time not recorded)'}${i.by ? ` by ${i.by}` : ''}` }
  }
  if (i.source === 'env') {
    return {
      badge: `From Vercel env · ${maskedTail(i.last4)}`,
      line: when ? `First seen ${when} (env vars carry no set date)` : 'Set in Vercel env; the date it was set is not recorded',
    }
  }
  return { badge: 'Not set', line: null }
}
