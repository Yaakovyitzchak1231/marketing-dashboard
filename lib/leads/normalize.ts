/**
 * The dedupe keys. Pure functions, shared by the importer, the research
 * engine, the webhook and the UI, so a store found three ways is one row.
 */

/** Hosts that are not a store's own website (profiles, link-in-bio, maps). */
const NOT_A_STORE_SITE = [
  'facebook.com', 'instagram.com', 'm.facebook.com', 'fb.com', 'yelp.com', 'google.com', 'goo.gl',
  'maps.google.com', 'business.site', 'linktr.ee', 'tiktok.com', 'twitter.com', 'x.com',
  'pinterest.com', 'youtube.com', 'etsy.com', 'linkedin.com', 'wixsite.com', 'square.site',
  'ebay.com', 'amazon.com', 'sites.google.com', 'yellowpages.com', 'mapquest.com', 'bbb.org',
  'nextdoor.com', 'foursquare.com', 'tripadvisor.com', 'linktree.com', 'beacons.ai',
]

/** Lowercase host without scheme, www., port or path. null when not a usable store domain. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null
  let s = String(input).trim().toLowerCase()
  if (!s) return null
  if (s.includes('@') && !s.includes('/')) s = s.split('@').pop() ?? ''
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.split(/[/?#]/)[0]
  s = s.replace(/:\d+$/, '').replace(/^www\d?\./, '').replace(/\.$/, '')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null
  if (NOT_A_STORE_SITE.some((h) => s === h || s.endsWith(`.${h}`))) return null
  return s
}

/** US/Canada numbers to E.164 (+1XXXXXXXXXX); other +country numbers kept if plausible. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null
  const raw = String(input).trim()
  const plus = raw.startsWith('+')
  const digits = raw.replace(/(ext|x|#).*$/i, '').replace(/\D/g, '')
  if (!plus && digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1') && /^[2-9]/.test(digits[1])) return `+${digits}`
  if (plus && digits.length >= 8 && digits.length <= 15) return `+${digits}`
  return null
}

export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null
  const s = String(input).trim().toLowerCase().replace(/^mailto:/, '')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null
  return s
}

function squash(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(llc|inc|co|corp|ltd|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** name|address|city|state, normalized. null unless there is a name and a place. */
export function nameAddressKey(
  name: string | null | undefined,
  address: string | null | undefined,
  city: string | null | undefined,
  state: string | null | undefined,
): string | null {
  const n = squash(name)
  const c = squash(city)
  const st = squash(state)
  if (!n || (!c && !squash(address))) return null
  return [n, squash(address), c, st].join('|')
}

const ROLE_LOCALPARTS = new Set([
  'info', 'sales', 'contact', 'hello', 'support', 'admin', 'office', 'service', 'customerservice',
  'help', 'team', 'mail', 'store', 'shop', 'orders', 'order', 'enquiries', 'inquiries', 'inquiry',
  'billing', 'accounts', 'marketing', 'jobs', 'careers', 'hr', 'webmaster', 'noreply', 'no-reply',
  'repairs', 'appointments', 'booking', 'reservations', 'general', 'frontdesk', 'reception',
])

export function isRoleAddress(email: string): boolean {
  const local = email.split('@')[0]?.toLowerCase() ?? ''
  return ROLE_LOCALPARTS.has(local.replace(/[0-9]+$/, ''))
}
