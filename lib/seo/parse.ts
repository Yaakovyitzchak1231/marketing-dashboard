/**
 * Pure parsers for the SEO audit. No network, no DB: every function takes
 * text and returns facts, so the audit's judgments are unit-testable.
 */

/** The AI crawlers that matter for "show up in ChatGPT / Claude / Gemini / Perplexity". */
export const AI_CRAWLERS = [
  { ua: 'GPTBot', who: 'OpenAI (training)' },
  { ua: 'OAI-SearchBot', who: 'ChatGPT search' },
  { ua: 'ChatGPT-User', who: 'ChatGPT browsing for a user' },
  { ua: 'ClaudeBot', who: 'Anthropic (Claude)' },
  { ua: 'Claude-User', who: 'Claude browsing for a user' },
  { ua: 'PerplexityBot', who: 'Perplexity' },
  { ua: 'Google-Extended', who: 'Gemini (Google AI)' },
  { ua: 'Googlebot', who: 'Google Search' },
  { ua: 'Bingbot', who: 'Bing (feeds ChatGPT search)' },
] as const

export interface RobotsGroup {
  agents: string[]
  rules: { allow: boolean; path: string }[]
}
export interface Robots {
  groups: RobotsGroup[]
  sitemaps: string[]
}

export function parseRobots(text: string): Robots {
  const groups: RobotsGroup[] = []
  const sitemaps: string[] = []
  let cur: RobotsGroup | null = null
  let lastWasAgent = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] }
        groups.push(cur)
      }
      cur.agents.push(val.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (key === 'sitemap') {
      if (val) sitemaps.push(val)
      continue
    }
    if (!cur) continue
    if (key === 'allow' || key === 'disallow') {
      // "Disallow:" with an empty path allows everything; skip it.
      if (key === 'disallow' && !val) continue
      cur.rules.push({ allow: key === 'allow', path: val })
    }
  }
  return { groups, sitemaps }
}

function pathMatches(rule: string, path: string): boolean {
  // Robots wildcards: * = anything, trailing $ = end.
  const anchored = rule.endsWith('$')
  const body = (anchored ? rule.slice(0, -1) : rule).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path)
}

/**
 * Is `path` allowed for `ua`? Uses the most specific matching group (the
 * longest agent token contained in the UA, else '*'), then the longest
 * matching rule; Allow wins ties. No group at all = allowed.
 */
export function robotsAllows(robots: Robots, ua: string, path = '/'): { allowed: boolean; group: string | null } {
  const u = ua.toLowerCase()
  let best: RobotsGroup | null = null
  let bestLen = -1
  let bestName: string | null = null
  for (const g of robots.groups) {
    for (const a of g.agents) {
      if (a !== '*' && u.includes(a) && a.length > bestLen) {
        best = g
        bestLen = a.length
        bestName = a
      }
    }
  }
  if (!best) {
    best = robots.groups.find((g) => g.agents.includes('*')) ?? null
    bestName = best ? '*' : null
  }
  if (!best) return { allowed: true, group: null }
  let verdict: { allow: boolean; len: number } | null = null
  for (const r of best.rules) {
    if (!pathMatches(r.path, path)) continue
    const len = r.path.length
    if (!verdict || len > verdict.len || (len === verdict.len && r.allow)) verdict = { allow: r.allow, len }
  }
  return { allowed: verdict ? verdict.allow : true, group: bestName }
}

/** SiteGround's anti-bot challenge (and similar walls) instead of the real page. */
export function detectBotWall(status: number | null, body: string): string | null {
  const b = body.slice(0, 4000)
  if (/\/\.well-known\/sgcaptcha\//.test(b)) return 'SiteGround anti-bot captcha'
  if (/cf-browser-verification|challenge-platform|Just a moment\.\.\./i.test(b) && (status === 403 || status === 503)) return 'Cloudflare challenge'
  if (status === 202 && b.length < 600 && /http-equiv=["']?refresh/i.test(b)) return 'redirect-to-challenge page (HTTP 202)'
  return null
}

export interface PageFacts {
  title: string | null
  description: string | null
  canonical: string | null
  robotsMeta: string | null
  h1: string[]
  schemaTypes: string[]
  schemaErrors: number
  wordCount: number
  generator: string | null
  hasFaqText: boolean
  /** First monthly price stated on the page, e.g. '$99/month' -> 99 (from the page's own words). */
  monthlyPrice: number | null
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : null
}

function metaContent(html: string, key: 'name' | 'property', value: string): string | null {
  const re = /<meta\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const v = attr(m[0], key)
    if (v && v.toLowerCase() === value) return attr(m[0], 'content')
  }
  return null
}

function collectTypes(node: unknown, out: string[]) {
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out)
  } else if (node && typeof node === 'object') {
    const t = (node as Record<string, unknown>)['@type']
    if (typeof t === 'string') out.push(t)
    else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.push(x)
    for (const v of Object.values(node as Record<string, unknown>)) collectTypes(v, out)
  }
}

export function parsePage(html: string): PageFacts {
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  let canonical: string | null = null
  const linkRe = /<link\b[^>]*>/gi
  let lm: RegExpExecArray | null
  while ((lm = linkRe.exec(html))) {
    if ((attr(lm[0], 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical')) {
      canonical = attr(lm[0], 'href')
      break
    }
  }
  const h1: string[] = []
  const h1Re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi
  let hm: RegExpExecArray | null
  while ((hm = h1Re.exec(html))) {
    const t = decode(hm[1].replace(/<[^>]+>/g, ' '))
    if (t) h1.push(t.slice(0, 160))
  }
  const types: string[] = []
  let schemaErrors = 0
  const ldRe = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi
  let sm: RegExpExecArray | null
  while ((sm = ldRe.exec(html))) {
    try {
      collectTypes(JSON.parse(sm[1]), types)
    } catch {
      schemaErrors++
    }
  }
  const text = decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
  return {
    title: titleM ? decode(titleM[1]) || null : null,
    description: metaContent(html, 'name', 'description'),
    canonical,
    robotsMeta: metaContent(html, 'name', 'robots'),
    h1,
    schemaTypes: [...new Set(types)].sort(),
    schemaErrors,
    wordCount: text ? text.split(' ').length : 0,
    generator: metaContent(html, 'name', 'generator'),
    hasFaqText: /frequently asked|\bFAQs?\b/i.test(text),
    monthlyPrice: (() => {
      const m = /\$\s?(\d{1,4}(?:\.\d{2})?)\s?(?:\/\s?mo(?:nth)?\b|per month|a month)/i.exec(text)
      return m ? Number(m[1]) : null
    })(),
  }
}

/** URLs in a sitemap (or the child sitemaps of a sitemap index). */
export function parseSitemap(xml: string): { isIndex: boolean; urls: string[] } {
  const isIndex = /<sitemapindex\b/i.test(xml)
  const urls: string[] = []
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) urls.push(decode(m[1]))
  return { isIndex, urls }
}

/** Pages that usually shouldn't be in a sitemap: tests, copies, thank-you pages, drafts. */
export function suspiciousSitemapUrls(urls: string[]): string[] {
  return urls.filter((u) => {
    let p: string
    try {
      p = new URL(u).pathname.toLowerCase()
    } catch {
      return false
    }
    return /(^|[/-])(test|testing|sample|demo|draft|copy|old|staging|thank-you|thanks|landing-page|hello-world)([/-]|$)|-\d+-copy\//.test(p)
  })
}

/** llms.txt: is it real (markdown, starts with a # title) and which links does it list? */
export function parseLlmsTxt(body: string, contentType: string | null): { valid: boolean; title: string | null; links: string[] } {
  const looksHtml = /<html|<!doctype/i.test(body.slice(0, 300)) || /text\/html/i.test(contentType ?? '')
  if (looksHtml) return { valid: false, title: null, links: [] }
  const first = body.split(/\r?\n/).find((l) => l.trim())
  const title = first && /^#\s+/.test(first) ? first.replace(/^#\s+/, '').replace(/\\(.)/g, '$1').trim() : null
  const links: string[] = []
  const re = /\]\((https?:\/\/[^)\s]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) links.push(m[1])
  return { valid: !!title, title, links }
}
