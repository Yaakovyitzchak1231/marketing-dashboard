/**
 * Verifying an AI-suggested campaign-profile item before Yaakov sees it (plan
 * 1.17): a feed actually parses as RSS/Atom and has recent items; a page
 * actually loads and robots.txt allows it; a subreddit actually exists.
 * Kinds with nothing to fetch (keyword, topic, search_phrase, place_category,
 * negative_keyword, signal_rule, fingerprint, social_channel) are
 * 'not_applicable' — there is nothing to check over HTTP.
 *
 * Writes verify_status / verify_detail / verified_at via
 * lib/campaign-profiles/store.ts's setItemVerify. Used by suggest.ts (every
 * suggestion, concurrency-limited, before it returns) and by the UI's
 * per-item "Re-check" button.
 */
import type { Db } from '../db/types.ts'
import { ITEM_KINDS, setItemVerify, type ItemKind, type VerifyStatus } from './store.ts'

export interface VerifyTarget {
  id?: number
  kind: ItemKind
  name: string
  value: string | null
  config: Record<string, unknown>
}

export interface VerifyOutcome {
  status: VerifyStatus
  detail: string | null
}

const NOT_APPLICABLE: readonly ItemKind[] = ['keyword', 'topic', 'search_phrase', 'place_category', 'negative_keyword', 'signal_rule', 'fingerprint', 'social_channel']

const DEFAULT_TIMEOUT_MS = 8_000
const UA = 'Mozilla/5.0 (compatible; TapDashBot/1.0; +https://tapdash.co)'

async function timedFetch(url: string, fetchImpl: typeof fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ res: Response | null; error: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: '*/*' } })
    return { res, error: null }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return { res: null, error: `timed out after ${Math.round(timeoutMs / 1000)}s` }
    return { res: null, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

function countFeedItems(xml: string): number {
  const rss = xml.match(/<item[\s>]/gi)
  if (rss) return rss.length
  const atom = xml.match(/<entry[\s>]/gi)
  return atom ? atom.length : 0
}

function newestFeedDate(xml: string): Date | null {
  const dates: Date[] = []
  for (const m of xml.matchAll(/<(?:pubDate|published|updated)>([^<]+)<\//gi)) {
    const d = new Date(m[1].trim())
    if (!Number.isNaN(d.getTime())) dates.push(d)
  }
  if (!dates.length) return null
  return new Date(Math.max(...dates.map((d) => d.getTime())))
}

async function verifyFeedItem(url: string, fetchImpl: typeof fetch): Promise<VerifyOutcome> {
  if (!/^https?:\/\//i.test(url)) return { status: 'failed', detail: 'value is not an http(s) URL' }
  const { res, error } = await timedFetch(url, fetchImpl)
  if (error) return { status: 'failed', detail: error }
  if (!res) return { status: 'failed', detail: 'no response' }
  if (!res.ok) return { status: 'failed', detail: `HTTP ${res.status}` }
  const text = await res.text()
  if (!/<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(text.slice(0, 4000))) return { status: 'failed', detail: 'does not parse as RSS/Atom' }
  const count = countFeedItems(text)
  const newest = newestFeedDate(text)
  if (!count) return { status: 'failed', detail: 'parses as a feed but has no items' }
  if (newest) {
    const days = Math.floor((Date.now() - newest.getTime()) / 86_400_000)
    const dateStr = newest.toISOString().slice(0, 10)
    if (days > 90) return { status: 'failed', detail: `${count} items, newest ${dateStr} (over 90 days old)` }
    return { status: 'ok', detail: `${count} items, newest ${dateStr}` }
  }
  return { status: 'ok', detail: `${count} items, no parseable dates` }
}

function robotsPathAllowed(robotsTxt: string, path: string): boolean {
  // A small, deliberately conservative robots.txt reader: the generic (User-agent: *)
  // block's Disallow lines, longest-prefix match wins; Allow overrides a shorter Disallow.
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim())
  let inStar = false
  let sawAnyAgent = false
  const rules: { allow: boolean; prefix: string }[] = []
  for (const line of lines) {
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i)
    if (!m) continue
    const [, key, val] = m
    if (/user-agent/i.test(key)) {
      sawAnyAgent = true
      inStar = val.trim() === '*'
      continue
    }
    if (!inStar) continue
    if (/disallow/i.test(key)) rules.push({ allow: false, prefix: val.trim() })
    else rules.push({ allow: true, prefix: val.trim() })
  }
  if (!sawAnyAgent) return true
  let best: { allow: boolean; prefix: string } | null = null
  for (const r of rules) {
    if (r.prefix === '') continue // an empty Disallow means "allow everything"
    if (path.startsWith(r.prefix)) {
      if (!best || r.prefix.length > best.prefix.length) best = r
    }
  }
  return best ? best.allow : true
}

async function verifyPageAndRobots(url: string, fetchImpl: typeof fetch, opts: { requireRobots: boolean }): Promise<VerifyOutcome> {
  if (!/^https?:\/\//i.test(url)) return { status: 'failed', detail: 'value is not an http(s) URL' }
  const { res, error } = await timedFetch(url, fetchImpl)
  if (error) return { status: 'failed', detail: error }
  if (!res) return { status: 'failed', detail: 'no response' }
  if (!(res.ok || (res.status >= 300 && res.status < 400))) return { status: 'failed', detail: `HTTP ${res.status}` }
  let robotsOk = true
  let robotsNote = ''
  try {
    const u = new URL(url)
    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`
    const { res: rr } = await timedFetch(robotsUrl, fetchImpl, 5_000)
    if (rr && rr.ok) {
      const txt = await rr.text()
      robotsOk = robotsPathAllowed(txt, u.pathname || '/')
      if (!robotsOk) robotsNote = `robots.txt disallows ${u.pathname || '/'}`
    }
  } catch {
    // no robots.txt reachable: treat as allowed, note nothing
  }
  if (!robotsOk) {
    if (opts.requireRobots) return { status: 'failed', detail: robotsNote }
    return { status: 'ok', detail: `page loads; ${robotsNote}` }
  }
  return { status: 'ok', detail: 'page loads' }
}

async function verifyForum(value: string, fetchImpl: typeof fetch): Promise<VerifyOutcome> {
  const m = value.match(/(?:^|\/)r\/([A-Za-z0-9_]+)\/?$/) || value.match(/^r\/([A-Za-z0-9_]+)$/)
  if (m) {
    const name = m[1]
    const { res, error } = await timedFetch(`https://www.reddit.com/r/${name}/about.json`, fetchImpl)
    if (error) return { status: 'failed', detail: error }
    if (!res) return { status: 'failed', detail: 'no response' }
    if (!res.ok) return { status: 'failed', detail: `r/${name}: HTTP ${res.status} (private, banned, or does not exist)` }
    try {
      const data = (await res.json()) as { data?: { subreddit_type?: string; subscribers?: number } }
      if (data.data?.subreddit_type === 'private' || data.data?.subreddit_type === 'banned') {
        return { status: 'failed', detail: `r/${name} is ${data.data.subreddit_type}` }
      }
      return { status: 'ok', detail: `r/${name} exists${data.data?.subscribers ? ` (${data.data.subscribers.toLocaleString()} members)` : ''}` }
    } catch {
      return { status: 'ok', detail: `r/${name} exists` }
    }
  }
  if (/^https?:\/\//i.test(value)) return verifyPageAndRobots(value, fetchImpl, { requireRobots: false })
  return { status: 'failed', detail: 'not a subreddit (r/name) or a URL' }
}

export interface VerifyDeps {
  fetchImpl?: typeof fetch
}

/** Check one item. Never throws: an unexpected error becomes {status:'failed', detail: message}. */
export async function verifyItem(item: VerifyTarget, deps: VerifyDeps = {}): Promise<VerifyOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    if ((NOT_APPLICABLE as readonly string[]).includes(item.kind)) return { status: 'not_applicable', detail: null }
    if (item.kind === 'feed') {
      if (!item.value) return { status: 'failed', detail: 'no feed URL' }
      return await verifyFeedItem(item.value, fetchImpl)
    }
    if (item.kind === 'forum') {
      const v = item.value ?? item.name
      if (!v) return { status: 'failed', detail: 'no URL or subreddit given' }
      return await verifyForum(v, fetchImpl)
    }
    if (item.kind === 'directory') {
      const url = item.value || (typeof item.config.url === 'string' ? item.config.url : null)
      if (!url) return { status: 'failed', detail: 'no URL given' }
      return await verifyPageAndRobots(url, fetchImpl, { requireRobots: true })
    }
    if (item.kind === 'competitor' || item.kind === 'trade_show') {
      const url = item.value
        || (typeof item.config.exhibitor_list_url === 'string' ? item.config.exhibitor_list_url : null)
        || (typeof item.config.newsroom_url === 'string' ? item.config.newsroom_url : null)
        || (typeof item.config.pricing_url === 'string' ? item.config.pricing_url : null)
      if (!url) return { status: 'not_applicable', detail: 'no URL to check' }
      return await verifyPageAndRobots(url, fetchImpl, { requireRobots: false })
    }
    return { status: 'not_applicable', detail: null }
  } catch (e) {
    return { status: 'failed', detail: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) }
  }
}

/** Run n async jobs with at most `limit` in flight at once. */
async function pool<T>(items: T[], limit: number, run: (x: T) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      await run(items[idx])
    }
  })
  await Promise.all(workers)
}

export interface VerifyManyResult {
  id: number
  status: VerifyStatus
  detail: string | null
}

/**
 * Verify many items concurrently (default concurrency 5, default overall
 * budget 30s: items not reached in time are left unchecked rather than
 * blocking the caller). Writes results via setItemVerify as each finishes.
 */
export async function verifyItemsAndSave(
  db: Db,
  actor: string,
  items: VerifyTarget[],
  opts: { concurrency?: number; budgetMs?: number } & VerifyDeps = {},
): Promise<VerifyManyResult[]> {
  const concurrency = opts.concurrency ?? 5
  const budgetMs = opts.budgetMs ?? 30_000
  const deadline = Date.now() + budgetMs
  const results: VerifyManyResult[] = []
  const withIds = items.filter((i): i is VerifyTarget & { id: number } => typeof i.id === 'number')
  await pool(withIds, concurrency, async (item) => {
    if (Date.now() > deadline) return
    const outcome = await verifyItem(item, deps_from(opts))
    const saved = await setItemVerify(db, actor, item.id, { status: outcome.status, detail: outcome.detail })
    results.push({ id: saved.id, status: saved.verify_status, detail: saved.verify_detail })
  })
  return results
}

function deps_from(opts: VerifyDeps): VerifyDeps {
  return { fetchImpl: opts.fetchImpl }
}

export { ITEM_KINDS }
