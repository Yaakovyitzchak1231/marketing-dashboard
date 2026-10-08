/**
 * Research one store from its own website: homepage, then up to 3
 * contact/about/team pages (robots.txt respected), reading emails, owner
 * lines, JSON-LD, phones and platform/payment signals. Ported from
 * scraper.py crawl_store + enrich.py site_stage.
 */
import { hostOf, regDomain } from './parse/domains.ts'
import {
  chooseOwner, cleanText, contactLinks, extractEmails, isFreemail, jsonldNames, namesFromText, onDomain, techSignals, telLinks,
  type ChosenOwner, type NameHit, type PageEmail,
} from './parse/extract.ts'
import { backoffMs, HostLimiter, HttpError, ProxyPool, request, sleep, UAS } from './io/http.ts'
import { ALLOW_ALL, parseRobots, type Robots } from './io/robots.ts'

export interface CrawlDeps {
  limiter: HostLimiter
  proxies: ProxyPool
  useProxies: boolean
  firstNames: Set<string>
  robots: Map<string, Robots>
  /** Per-page deadline. */
  timeoutMs?: number
  /** Swap the network in tests. */
  fetchPage?: typeof request
  /** Wait before the one retry after a 429 (default 6-12 s). */
  retry429Ms?: number
  /** Base for retry backoff on network errors / 5xx (default 800 ms). */
  backoffBaseMs?: number
}

export interface CrawlResult {
  domain: string
  final_url: string | null
  site_ok: boolean
  /** Shopify-style 429 wall: the store's host refused us; the search fallback can still find its email. */
  blocked: boolean
  pages: { url: string; status: number | null; error?: string }[]
  emails: (PageEmail & { evidence_url: string })[]
  /** Addresses on other companies' domains (a web designer, a brand): kept for the record, not written as contacts. */
  offsite_emails: string[]
  names: (NameHit & { url: string })[]
  owner: ChosenOwner | null
  phones: { phone: string; evidence_url: string }[]
  signals: { signal: string; evidence_url: string }[]
}

async function getRobots(origin: string, d: CrawlDeps): Promise<Robots> {
  const hit = d.robots.get(origin)
  if (hit) return hit
  let r: Robots = ALLOW_ALL
  try {
    const res = await (d.fetchPage ?? request)(`${origin}/robots.txt`, { timeoutMs: 8000, maxBytes: 200_000, proxy: d.useProxies ? d.proxies.next() : null })
    if (res.status === 200 && !/<html/i.test(res.body.slice(0, 500))) r = parseRobots(res.body)
  } catch {
    /* unreachable robots.txt = allowed */
  }
  d.robots.set(origin, r)
  return r
}

/** One page with per-host politeness, retries and backoff. Never throws. */
export async function politeGet(url: string, d: CrawlDeps): Promise<{ status: number | null; url: string; body: string | null; error?: string; blocked?: boolean }> {
  const host = hostOf(url)
  if (d.limiter.benched(host)) return { status: null, url, body: null, error: 'host is rate-limiting us (benched)', blocked: true }
  let lastErr = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const proxy = d.useProxies ? d.proxies.next() : null
    await d.limiter.acquire(host)
    try {
      const r = await (d.fetchPage ?? request)(url, {
        timeoutMs: d.timeoutMs ?? 15_000,
        proxy,
        headers: { 'user-agent': UAS[attempt % UAS.length] },
      })
      d.proxies.report(proxy, r.status < 500 && r.status !== 429)
      if (r.status === 429) {
        if (attempt === 0) {
          await sleep(d.retry429Ms ?? 6000 + Math.random() * 6000)
          continue
        }
        d.limiter.benchHost(host, 15 * 60_000)
        return { status: 429, url: r.url, body: null, error: 'rate limited (429)', blocked: true }
      }
      if (r.status >= 500 && attempt < 2) {
        await sleep(backoffMs(attempt, d.backoffBaseMs ?? 1000))
        continue
      }
      const ct = r.headers['content-type'] ?? ''
      if (r.status >= 400) return { status: r.status, url: r.url, body: null, error: `HTTP ${r.status}` }
      if (ct && !/html|text/i.test(ct)) return { status: r.status, url: r.url, body: null, error: `not a web page (${ct.split(';')[0]})` }
      return { status: r.status, url: r.url, body: r.body }
    } catch (e) {
      d.proxies.report(proxy, false)
      lastErr = e instanceof HttpError ? `${e.code}: ${e.message}` : (e as Error).message
      if (attempt < 2) await sleep(backoffMs(attempt, d.backoffBaseMs ?? 800, 5000))
    } finally {
      d.limiter.release(host)
    }
  }
  return { status: null, url, body: null, error: lastErr || 'unreachable' }
}

function readPage(html: string, url: string, out: CrawlResult, d: CrawlDeps) {
  for (const e of extractEmails(html)) {
    if (out.emails.some((x) => x.email === e.email) || out.offsite_emails.includes(e.email)) continue
    if (onDomain(e.email, out.domain) || isFreemail(e.email)) out.emails.push({ ...e, evidence_url: url })
    else out.offsite_emails.push(e.email)
  }
  const text = cleanText(html)
  for (const n of [...namesFromText(text, d.firstNames), ...jsonldNames(html, d.firstNames)]) out.names.push({ ...n, url })
  for (const t of telLinks(html)) if (!out.phones.some((p) => p.phone === t)) out.phones.push({ phone: t, evidence_url: url })
  for (const s of techSignals(html)) if (!out.signals.some((x) => x.signal === s)) out.signals.push({ signal: s, evidence_url: url })
}

export async function crawlSite(website: string, d: CrawlDeps): Promise<CrawlResult> {
  let site = website.trim()
  if (!/^https?:\/\//i.test(site)) site = 'http://' + site
  const u = new URL(site)
  const domain = regDomain(hostOf(site))
  const out: CrawlResult = { domain, final_url: null, site_ok: false, blocked: false, pages: [], emails: [], offsite_emails: [], names: [], owner: null, phones: [], signals: [] }
  const root = `${u.protocol}//${u.host}/`
  const tries = [root]
  if (site.replace(/\/$/, '') !== root.replace(/\/$/, '')) tries.push(site)
  tries.push(root.startsWith('http://') ? root.replace('http://', 'https://') : root.replace('https://', 'http://'))
  let home: { url: string; body: string } | null = null
  for (const t of tries) {
    const r = await politeGet(t, d)
    out.pages.push({ url: t, status: r.status, ...(r.error ? { error: r.error } : {}) })
    if (r.blocked) out.blocked = true
    if (r.body != null) {
      home = { url: r.url, body: r.body }
      break
    }
    if (r.blocked) break
  }
  if (!home) return out
  out.site_ok = true
  out.final_url = home.url
  readPage(home.body, home.url, out, d)
  const origin = new URL(home.url).origin
  const robots = await getRobots(origin, d)
  let links = contactLinks(home.body, home.url, 3)
  if (!links.length) links = [`${origin}/contact`, `${origin}/about`, `${origin}/contact-us`]
  for (const link of links) {
    const path = new URL(link).pathname
    if (!robots.allows(path)) {
      out.pages.push({ url: link, status: null, error: 'disallowed by robots.txt' })
      continue
    }
    const r = await politeGet(link, d)
    out.pages.push({ url: link, status: r.status, ...(r.error ? { error: r.error } : {}) })
    if (r.blocked) {
      out.blocked = true
      break
    }
    if (r.body != null) readPage(r.body, r.url, out, d)
  }
  out.owner = chooseOwner(out.names, out.emails.filter((e) => onDomain(e.email, domain)).map((e) => e.email))
  return out
}
