/**
 * SSRF guard for provider base URLs that can be saved from /settings (ai.base_url).
 * A value that fails here is treated as "not configured" — never fetched.
 *
 * - https only
 * - no localhost / *.localhost / *.local / *.internal hostnames
 * - no literal IPs in loopback, private, link-local (incl. 169.254.169.254
 *   metadata), CGNAT, unspecified, IPv6 ULA / link-local / loopback, or
 *   IPv4-mapped forms of those
 * assertPublicHost() additionally resolves the hostname (DNS) right before a
 * fetch and refuses if any address is private. (A DNS-rebinding race between
 * the lookup and fetch's own lookup is still theoretically possible.)
 */
import { isIP } from 'node:net'

function v4Blocked(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  )
}

function v6Blocked(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (s === '::' || s === '::1') return true
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return v4Blocked(mapped[1])
  const hexMapped = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16)
    return v4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  const first = parseInt(s.split(':')[0] || '0', 16)
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10
  return false
}

/** True when an IP literal (v4 or v6) is not a public address. */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '')
  const kind = isIP(bare)
  if (kind === 4) return v4Blocked(bare)
  if (kind === 6) return v6Blocked(bare)
  return false
}

/** null when `value` is an https URL to a public host; otherwise the reason. */
export function validatePublicHttpsUrl(value: string): string | null {
  let u: URL
  try {
    u = new URL(value.trim())
  } catch {
    return 'That does not look like a URL.'
  }
  if (u.protocol !== 'https:') return 'Must be an https:// URL.'
  if (u.username || u.password) return 'Must not contain a username or password.'
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return 'Must include a host name.'
  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return 'Must be a public host, not a local one.'
  const bare = host.replace(/^\[|\]$/g, '')
  if (isIP(bare) ? isBlockedIp(bare) : /^[0-9.]+$/.test(bare) || /^0x/i.test(bare)) {
    return 'Must be a public address, not a private, loopback or link-local one.'
  }
  return null
}

type Lookup = (host: string) => Promise<{ address: string }[]>
const defaultLookup: Lookup = async (host) => {
  const { lookup } = await import('node:dns/promises')
  return lookup(host, { all: true })
}

/** Resolve the URL's host and refuse when any address is private. Throws Error with a safe message. */
export async function assertPublicHost(url: string, lookup: Lookup = defaultLookup): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error('The AI provider address is not a public address.')
    return
  }
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host)
  } catch {
    throw new Error('Could not resolve the AI provider host name.')
  }
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) throw new Error('The AI provider host resolves to a non-public address.')
}
