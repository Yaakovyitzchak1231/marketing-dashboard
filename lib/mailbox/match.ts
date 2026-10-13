/**
 * Pure matching rules for "1:1 emails with this lead". No I/O, so the rules are
 * tested directly (tests/mailbox.test.ts).
 *
 * A message counts when the connected mailbox and one of the lead's addresses
 * are on opposite ends of it:
 *  - received: the lead's address is the sender;
 *  - sent: the connected mailbox is the sender and the lead's address is in To or Cc.
 * Drafts never count. A message where neither end is the lead (the lead only in
 * a forwarded body, a search hit on a display name) does not count.
 */

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = raw.trim().toLowerCase()
  return EMAIL_RE.test(v) && v.length <= 254 ? v : null
}

/** The lead's distinct, valid addresses, in first-seen order, capped (each one is one search). */
export function leadAddresses(raw: (string | null | undefined)[], cap = 10): string[] {
  const out: string[] = []
  for (const r of raw) {
    const e = normalizeEmail(r)
    if (e && !out.includes(e)) out.push(e)
    if (out.length >= cap) break
  }
  return out
}

export interface MessageEnds {
  from: string | null
  to: string[]
  cc: string[]
  isDraft?: boolean | null
}

/** 'sent' | 'received' when the message is between `mailbox` and `lead`, else null. */
export function directionOf(m: MessageEnds, mailbox: string, lead: string): 'sent' | 'received' | null {
  if (m.isDraft) return null
  const me = normalizeEmail(mailbox)
  const them = normalizeEmail(lead)
  if (!me || !them || me === them) return null
  const from = normalizeEmail(m.from)
  if (from === them) return 'received'
  if (from === me) {
    const rcpts = [...m.to, ...m.cc].map((x) => normalizeEmail(x))
    if (rcpts.includes(them)) return 'sent'
  }
  return null
}

/** Merge several providers' / addresses' lists: drop duplicates (same provider + id), newest first. */
export function mergeMessages<T extends { provider: string; id: string; at: string }>(lists: T[][], limit: number): { messages: T[]; truncated: boolean } {
  const seen = new Set<string>()
  const all: T[] = []
  for (const list of lists) {
    for (const m of list) {
      const k = `${m.provider}:${m.id}`
      if (seen.has(k)) continue
      seen.add(k)
      all.push(m)
    }
  }
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return { messages: all.slice(0, limit), truncated: all.length > limit }
}
