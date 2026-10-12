/**
 * SSRF guard for provider base URLs that can be saved from /settings (ai.base_url).
 * A value that fails here is treated as "not configured" — never fetched.
 *
 * validatePublicHttpsUrl() (static, no DNS):
 * - https only, port 80 or 443 only (explicit or default), no user:password
 * - no localhost / *.localhost / *.local / *.internal hostnames
 * - no literal IP in a non-public range (see v4Blocked / v6Blocked below), including
 *   the IPv4 embedded in IPv4-mapped, IPv4-compatible, NAT64 and 6to4 IPv6 forms
 *
 * createGuardedLookup() (DNS, at connect time): the `lookup` function handed to
 * node:https. It resolves the host, refuses when ANY answer is non-public, and returns the
 * very address it checked, so the socket connects to exactly the validated IP and a
 * DNS-rebinding answer between "check" and "connect" cannot happen (there is no second
 * resolution). assertPublicHost() is the same check as a plain pre-flight.
 */
import { isIP } from 'node:net'

/** IPv4 dotted quad -> true when it is not a public unicast address. */
function v4Blocked(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b, c] = p
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10.0.0.0/8
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // link-local incl. 169.254.169.254 metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    a >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved (incl. broadcast)
  )
}

/** Expand an IPv6 literal into its eight 16-bit groups, or null when it does not parse. */
function v6Groups(input: string): number[] | null {
  let s = input.toLowerCase().replace(/^\[|\]$/g, '')
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)
  // A trailing dotted quad (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) is two groups.
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const q = dotted[2].split('.').map(Number)
    if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    s = `${dotted[1]}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  if (!head || !tail) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null
  return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

const embeddedV4 = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`

/** IPv6 literal -> true when it is not a public global-unicast address (fail-closed on parse errors). */
function v6Blocked(ip: string): boolean {
  const g = v6Groups(ip)
  if (!g) return true
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  // :: (unspecified), ::1 (loopback) and ::/96 IPv4-compatible (deprecated): judged by the embedded IPv4
  // (::, ::1 and ::a.b.c.d with a=0 all land in 0.0.0.0/8).
  if (firstFiveZero && g5 === 0) return v4Blocked(embeddedV4(g6, g7))
  // ::ffff:0:0/96 IPv4-mapped: judged by the embedded IPv4.
  if (firstFiveZero && g5 === 0xffff) return v4Blocked(embeddedV4(g6, g7))
  // 64:ff9b::/96 NAT64 well-known prefix: judged by the embedded IPv4.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4Blocked(embeddedV4(g6, g7))
  // 64:ff9b:1::/48 local-use NAT64 (RFC 8215): never public.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true
  // 2002::/16 6to4: the IPv4 sits in groups 1-2.
  if (g0 === 0x2002) return v4Blocked(embeddedV4(g1, g2))
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true // 100::/64 discard-only
  if (g0 === 0x2001 && g1 === 0) return true // 2001::/32 Teredo
  if (g0 === 0x2001 && g1 === 0xdb8) return true // 2001:db8::/32 documentation
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/** True when an IP literal (v4 or v6) is not a public address. Anything that is not an IP literal is refused too. */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '')
  const kind = isIP(bare)
  if (kind === 4) return v4Blocked(bare)
  if (kind === 6) return v6Blocked(bare)
  return true
}

/** null when `value` is an https URL to a public host on port 80/443; otherwise the reason. */
export function validatePublicHttpsUrl(value: string): string | null {
  let u: URL
  try {
    u = new URL(value.trim())
  } catch {
    return 'That does not look like a URL.'
  }
  if (u.protocol !== 'https:') return 'Must be an https:// URL.'
  if (u.username || u.password) return 'Must not contain a username or password.'
  // URL drops a default port (443 for https) so `port` is '' then; anything else is explicit.
  if (u.port && u.port !== '80' && u.port !== '443') return 'Port must be 80 or 443 (or left out); other ports are not allowed.'
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return 'Must include a host name.'
  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return 'Must be a public host, not a local one.'
  const bare = host.replace(/^\[|\]$/g, '')
  if (isIP(bare) ? isBlockedIp(bare) : /^[0-9.]+$/.test(bare) || /^0x/i.test(bare)) {
    return 'Must be a public address, not a private, loopback or link-local one.'
  }
  return null
}

export interface ResolvedAddress {
  address: string
  family?: number
}
export type Lookup = (host: string) => Promise<ResolvedAddress[]>

const defaultLookup: Lookup = async (host) => {
  const { lookup } = await import('node:dns/promises')
  return lookup(host, { all: true })
}

/** Thrown by the guards below. `message` is safe to show a person. */
export class BlockedAddressError extends Error {
  code = 'EBLOCKEDADDR'
  constructor(message: string) {
    super(message)
    this.name = 'BlockedAddressError'
  }
}

/** Throw unless the resolver answered with at least one address and every one is public. */
function assertAnswersPublic(addrs: ResolvedAddress[]): void {
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) {
    throw new BlockedAddressError('The AI provider host resolves to a non-public address.')
  }
}

async function resolveOrThrow(host: string, lookup: Lookup): Promise<ResolvedAddress[]> {
  try {
    return await lookup(host)
  } catch {
    throw new BlockedAddressError('Could not resolve the AI provider host name.')
  }
}

/** Resolve the URL's host and refuse when any address is private. Throws Error with a safe message. */
export async function assertPublicHost(url: string, lookup: Lookup = defaultLookup): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new BlockedAddressError('The AI provider address is not a public address.')
    return
  }
  assertAnswersPublic(await resolveOrThrow(host, lookup))
}

type LookupCallback = (err: Error | null, address?: string | ResolvedAddress[], family?: number) => void
interface LookupOptions {
  all?: boolean
  family?: number | string
}

/**
 * A `lookup` for node:https/net.connect (the `lookup` request option). It resolves `hostname`,
 * refuses when any answer is non-public (or there is none), and hands back only the checked
 * addresses, so the connection uses exactly the IP that passed. Honors `options.all` (Node's
 * happy-eyeballs path asks for all) and `options.family`.
 */
export function createGuardedLookup(resolve: Lookup = defaultLookup) {
  return (hostname: string, optionsOrCb: LookupOptions | LookupCallback, maybeCb?: LookupCallback): void => {
    const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as LookupCallback
    const options: LookupOptions = typeof optionsOrCb === 'function' ? {} : optionsOrCb ?? {}
    void (async () => {
      const answers = await resolveOrThrow(hostname.replace(/^\[|\]$/g, ''), resolve)
      assertAnswersPublic(answers)
      const wanted = options.family === 4 || options.family === '4' || options.family === 'IPv4' ? 4
        : options.family === 6 || options.family === '6' || options.family === 'IPv6' ? 6 : 0
      const checked = answers
        .map((a) => ({ address: a.address, family: a.family === 4 || a.family === 6 ? a.family : isIP(a.address) }))
        .filter((a) => !wanted || a.family === wanted)
      if (!checked.length) throw new BlockedAddressError('The AI provider host has no address of the requested family.')
      return checked
    })().then(
      (checked) => (options.all ? cb(null, checked) : cb(null, checked[0].address, checked[0].family)),
      (err: Error) => cb(err),
    )
  }
}
