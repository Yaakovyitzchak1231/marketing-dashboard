/**
 * The free first tier of the waterfall. No paid call, no SMTP probing: only
 * syntax, DNS, and local lists. Anything this rejects never costs a credit.
 *
 *   invalid  -> bad syntax, the domain does not exist / has no mail server
 *               (no MX; see "A only" below), a null MX (RFC 7505), or a disposable domain
 *   unknown  -> DNS itself failed (timeout / SERVFAIL): we could not tell, so the
 *               address goes on to the paid tier rather than being thrown away
 *   pass     -> everything else (role and free-provider addresses are flagged,
 *               never rejected)
 *
 * No MX but an A/AAAA record ("A only"): RFC 5321 §5.1 allows mail to the A
 * record as an implicit MX, but on Yaakov's real leads it is a website host,
 * not a mail server. Measured Oct 8 2026 on 200 unverified Lead Master
 * contacts: 53 had no MX and an A record, and the A records checked were
 * Cloudflare (172.67.x / 104.21.x), Shopify (23.227.38.69) and a hosting
 * accelerator (13.248.x / 76.223.x): web servers that don't take SMTP. So by
 * default an A-only domain is `invalid` (result `no_mx_a_only`, flagged
 * implicit_mx) and costs nothing. Set VERIFY_A_ONLY=unknown to send those to
 * the paid tier instead.
 */
import { promises as dnsPromises } from 'node:dns'
import { isRoleAddress } from '@/lib/leads/normalize'
import { DISPOSABLE_DOMAINS } from './disposable-domains'

export interface MxRecord {
  exchange: string
  priority: number
}

/** The DNS calls the precheck needs; node:dns/promises fits, tests inject a fake. */
export interface DnsResolver {
  resolveMx(domain: string): Promise<MxRecord[]>
  resolve4(domain: string): Promise<string[]>
  resolve6(domain: string): Promise<string[]>
}

export type PrecheckWord =
  | 'ok'
  | 'no_mx_a_only'
  | 'bad_syntax'
  | 'no_mx'
  | 'null_mx'
  | 'disposable'
  | 'dns_error'

export interface PrecheckResult {
  email: string
  domain: string | null
  verdict: 'pass' | 'invalid' | 'unknown'
  /** Our own word for what the free check found (stored as verification_results.result). */
  result: PrecheckWord
  flags: {
    role: boolean
    free_provider: boolean
    disposable: boolean
    implicit_mx: boolean
  }
  mx: string[] | null
}

export const FREE_PROVIDERS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.co.uk',
  'aol.com', 'aim.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'hotmail.co.uk',
  'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'pm.me', 'gmx.com',
  'gmx.net', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'comcast.net', 'verizon.net',
  'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net',
  'optonline.net', 'frontier.com', 'windstream.net', 'juno.com', 'netzero.net', 'roadrunner.com',
  'rr.com', 'q.com', 'centurylink.net', 'fastmail.com', 'hey.com', 'tutanota.com',
])

// Local part: RFC 5322 "atext" dot-atoms (no quoted strings: no real lead uses them).
const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

/** Syntax only. Returns the lowercased domain when the address is well formed. */
export function checkSyntax(email: string): { ok: boolean; domain: string | null } {
  const e = email.trim()
  if (e.length === 0 || e.length > 254) return { ok: false, domain: null }
  const at = e.lastIndexOf('@')
  if (at <= 0 || at !== e.indexOf('@')) return { ok: false, domain: null }
  const local = e.slice(0, at)
  const domain = e.slice(at + 1).toLowerCase().replace(/\.$/, '')
  if (local.length > 64 || !LOCAL_RE.test(local)) return { ok: false, domain: null }
  const labels = domain.split('.')
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return { ok: false, domain: null }
  const tld = labels[labels.length - 1]
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i.test(tld)) return { ok: false, domain: null }
  return { ok: true, domain }
}

type DomainDns =
  | { kind: 'mx'; mx: string[] }
  | { kind: 'null_mx' }
  | { kind: 'implicit'; mx: string[] }
  | { kind: 'none' }
  | { kind: 'error'; code: string }

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME'])

function code(e: unknown): string {
  return (e as { code?: string })?.code ?? 'EUNKNOWN'
}

async function lookupDomain(domain: string, r: DnsResolver): Promise<DomainDns> {
  let mx: MxRecord[] = []
  try {
    mx = await r.resolveMx(domain)
  } catch (e) {
    const c = code(e)
    if (c === 'ENOTFOUND' || c === 'NXDOMAIN' || c === 'ENONAME') return { kind: 'none' } // the domain does not exist
    if (!NOT_FOUND.has(c)) return { kind: 'error', code: c }
    mx = [] // ENODATA: domain exists, no MX -> try the implicit MX
  }
  if (mx.length > 0) {
    // RFC 7505: a single MX of "." means "this domain accepts no mail".
    if (mx.every((m) => m.exchange === '' || m.exchange === '.')) return { kind: 'null_mx' }
    return { kind: 'mx', mx: [...mx].sort((a, b) => a.priority - b.priority).map((m) => m.exchange) }
  }
  let sawError: string | null = null
  for (const fn of [r.resolve4.bind(r), r.resolve6.bind(r)]) {
    try {
      const addrs = await fn(domain)
      if (addrs.length > 0) return { kind: 'implicit', mx: [domain] }
    } catch (e) {
      const c = code(e)
      if (!NOT_FOUND.has(c)) sawError = c
    }
  }
  return sawError ? { kind: 'error', code: sawError } : { kind: 'none' }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' })), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export interface Prechecker {
  check(email: string): Promise<PrecheckResult>
  /** How many distinct domains were looked up (for tests and logs). */
  lookups(): number
}

/**
 * A prechecker with a per-instance domain cache: one DNS lookup per domain,
 * however many addresses share it. Create one per request / batch.
 */
export function createPrechecker(
  opts: { resolver?: DnsResolver; timeoutMs?: number; aOnly?: 'invalid' | 'unknown' } = {},
): Prechecker {
  const resolver: DnsResolver = opts.resolver ?? dnsPromises
  const timeoutMs = opts.timeoutMs ?? 5000
  const aOnly = opts.aOnly ?? (process.env.VERIFY_A_ONLY === 'unknown' ? 'unknown' : 'invalid')
  const cache = new Map<string, Promise<DomainDns>>()
  const timed: DnsResolver = {
    resolveMx: (d) => withTimeout(resolver.resolveMx(d), timeoutMs),
    resolve4: (d) => withTimeout(resolver.resolve4(d), timeoutMs),
    resolve6: (d) => withTimeout(resolver.resolve6(d), timeoutMs),
  }

  return {
    lookups: () => cache.size,
    async check(rawEmail: string): Promise<PrecheckResult> {
      const email = rawEmail.trim().toLowerCase()
      const syntax = checkSyntax(email)
      const flags = { role: false, free_provider: false, disposable: false, implicit_mx: false }
      if (!syntax.ok || !syntax.domain) {
        return { email, domain: null, verdict: 'invalid', result: 'bad_syntax', flags, mx: null }
      }
      const domain = syntax.domain
      flags.role = isRoleAddress(email)
      flags.free_provider = FREE_PROVIDERS.has(domain)
      flags.disposable = DISPOSABLE_DOMAINS.has(domain)
      if (flags.disposable) {
        return { email, domain, verdict: 'invalid', result: 'disposable', flags, mx: null }
      }
      let pending = cache.get(domain)
      if (!pending) {
        pending = lookupDomain(domain, timed).catch((e) => ({ kind: 'error' as const, code: code(e) }))
        cache.set(domain, pending)
      }
      const dns = await pending
      switch (dns.kind) {
        case 'mx':
          return { email, domain, verdict: 'pass', result: 'ok', flags, mx: dns.mx }
        case 'implicit':
          flags.implicit_mx = true
          return { email, domain, verdict: aOnly, result: 'no_mx_a_only', flags, mx: dns.mx }
        case 'null_mx':
          return { email, domain, verdict: 'invalid', result: 'null_mx', flags, mx: null }
        case 'none':
          return { email, domain, verdict: 'invalid', result: 'no_mx', flags, mx: null }
        case 'error':
          return { email, domain, verdict: 'unknown', result: 'dns_error', flags, mx: null }
      }
    },
  }
}

/** Run checks with bounded concurrency, preserving input order. */
export async function precheckMany(
  emails: string[],
  checker: Prechecker,
  concurrency = 16,
): Promise<PrecheckResult[]> {
  const out = new Array<PrecheckResult>(emails.length)
  let next = 0
  const worker = async () => {
    while (next < emails.length) {
      const i = next++
      out[i] = await checker.check(emails[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, emails.length) }, worker))
  return out
}
