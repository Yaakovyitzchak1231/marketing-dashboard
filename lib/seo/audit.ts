import {
  AI_CRAWLERS,
  detectBotWall,
  parseLlmsTxt,
  parsePage,
  parseRobots,
  parseSitemap,
  robotsAllows,
  suspiciousSitemapUrls,
  type PageFacts,
} from './parse'

/**
 * The technical audit: plain HTTP fetches + the pure parsers. Every check is
 * pass | warn | fail | unknown, and `unknown` means we could not measure it
 * (a bot wall, a timeout, a missing key) — never a guess dressed as a result.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown' | 'info'
export interface Check {
  id: string
  label: string
  status: CheckStatus
  detail: string
  fix?: string
  page?: string
}

export interface FetchResult {
  status: number | null
  contentType: string | null
  body: string
  error: string | null
  wall: string | null
  finalUrl: string | null
}

export type Fetcher = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number
  url?: string
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

export interface AuditSite {
  base_url: string
  platform?: string | null
  host?: string | null
  pages?: string[] | null
}

export interface AuditOptions {
  fetcher?: Fetcher
  pagespeedKey?: string | null
  timeoutMs?: number
  /** max child sitemaps to read from a sitemap index */
  maxChildSitemaps?: number
}

export const AUDIT_UA = 'Mozilla/5.0 (compatible; TapDashSEOAudit/1.0; +https://tapdash.co)'

async function grab(fetcher: Fetcher, url: string, timeoutMs: number): Promise<FetchResult> {
  try {
    const r = await fetcher(url, { headers: { 'User-Agent': AUDIT_UA, Accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) })
    const body = await r.text()
    return {
      status: r.status,
      contentType: r.headers.get('content-type'),
      body,
      error: null,
      wall: detectBotWall(r.status, body),
      finalUrl: r.url || url,
    }
  } catch (e) {
    return { status: null, contentType: null, body: '', error: (e as Error).message || String(e), wall: null, finalUrl: null }
  }
}

export function originOf(baseUrl: string): string {
  const u = new URL(/^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`)
  return `${u.protocol}//${u.host}`
}

const hostKey = (h: string) => h.toLowerCase().replace(/^www\./, '')

function wpFix(site: AuditSite, wp: string, other: string): string {
  return (site.platform ?? '').toLowerCase() === 'wordpress' ? wp : other
}

export function summarize(checks: Check[]) {
  const n = (s: CheckStatus) => checks.filter((c) => c.status === s).length
  return { passed: n('pass'), failed: n('fail'), warned: n('warn'), unknown: n('unknown') }
}

const WALLED = (what: string, wall: string): Check['detail'] =>
  `Couldn't read ${what}: the server answered with a ${wall} instead of the page.`

export interface AuditPage {
  url: string
  title: string | null
  description: string | null
  canonical: string | null
  h1: string[]
  schemaTypes: string[]
  monthlyPrice: number | null
  wordCount: number
}
export interface AuditResult {
  checks: Check[]
  pages: Record<string, AuditPage>
  sitemapUrls: string[] | null
}

export async function runAudit(site: AuditSite, opts: AuditOptions = {}): Promise<AuditResult> {
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as Fetcher)
  const timeoutMs = opts.timeoutMs ?? 15000
  const origin = originOf(site.base_url)
  const checks: Check[] = []
  const walls: string[] = []

  // ---- robots.txt
  const robotsRes = await grab(fetcher, `${origin}/robots.txt`, timeoutMs)
  let sitemapHints: string[] = []
  if (robotsRes.wall) {
    walls.push(robotsRes.wall)
    checks.push({ id: 'robots', label: 'AI crawlers in robots.txt', status: 'unknown', detail: WALLED('robots.txt', robotsRes.wall) })
  } else if (robotsRes.error || robotsRes.status == null) {
    checks.push({ id: 'robots', label: 'AI crawlers in robots.txt', status: 'unknown', detail: `robots.txt didn't load (${robotsRes.error ?? 'no answer'}).` })
  } else if (robotsRes.status === 404) {
    checks.push({
      id: 'robots',
      label: 'AI crawlers in robots.txt',
      status: 'warn',
      detail: 'No robots.txt (HTTP 404). Crawlers are allowed by default, but there is no Sitemap line pointing them to your pages.',
      fix: wpFix(site, 'Yoast creates one automatically: Yoast SEO > Tools > File editor, or check that nothing deletes it.', 'Add a robots.txt with "User-agent: *", "Allow: /" and a Sitemap: line.'),
    })
  } else if (robotsRes.status >= 200 && robotsRes.status < 300) {
    const robots = parseRobots(robotsRes.body)
    sitemapHints = robots.sitemaps
    const paths = [...new Set(['/', ...(site.pages ?? []).map((p) => p.startsWith('/') ? p : `/${p}`)])]
    const searchBots = AI_CRAWLERS.filter((c) => c.purpose === 'search')
    const blocked = searchBots.flatMap((c) => paths.filter((p) => !robotsAllows(robots, c.ua, p).allowed).map((path) => ({ ...c, path })))
    const policies = AI_CRAWLERS.filter((c) => c.purpose !== 'search' && !robotsAllows(robots, c.ua, '/').allowed)
    checks.push({ id: 'crawler_policy', label: 'Training and user-fetch policy', status: 'info', detail: `${policies.length ? `Root rules disallow: ${policies.map((c) => c.ua).join(', ')}.` : 'No root disallow rule detected for the non-search agents checked.'} These are separate policy choices, not search visibility failures. User-triggered fetches may not follow robots.txt. Google-Extended is not required for Google Search AI features.` })
    checks.push(
      blocked.length
        ? {
            id: 'robots',
            label: 'AI crawlers in robots.txt',
            status: 'fail',
            detail: `robots.txt blocks search discovery on tracked paths: ${blocked.map((b) => `${b.ua} at ${b.path}`).join(', ')}.`,
            fix: wpFix(
              site,
              'Review the listed search-bot/path rules in Yoast or your host. Allow only pages intended for public discovery; preserve private paths and your training opt-outs.',
              'Review the listed search-bot/path rules. Allow public content intentionally; do not change training policy or expose private pages.',
            ),
          }
        : {
            id: 'robots',
            label: 'AI crawlers in robots.txt',
            status: 'pass',
            detail: `${searchBots.length} search crawlers allowed by robots.txt on ${paths.length} tracked paths. This does not verify crawler visits, firewall access, indexing or citations.`,
          },
    )
  } else {
    checks.push({ id: 'robots', label: 'AI crawlers in robots.txt', status: 'unknown', detail: `robots.txt answered HTTP ${robotsRes.status}.` })
  }

  // ---- llms.txt
  const llms = await grab(fetcher, `${origin}/llms.txt`, timeoutMs)
  if (llms.wall) {
    walls.push(llms.wall)
    checks.push({ id: 'llms_txt', label: 'llms.txt', status: 'unknown', detail: WALLED('/llms.txt', llms.wall) })
  } else if (llms.status === 200) {
    const p = parseLlmsTxt(llms.body, llms.contentType)
    checks.push(
      p.valid
        ? {
            id: 'llms_txt',
            label: 'llms.txt',
            status: 'info',
            detail: `Optional llms.txt titled "${p.title}" lists ${p.links.length} link${p.links.length === 1 ? '' : 's'}. Its presence is not evidence of search visibility or citations.`,
          }
        : {
            id: 'llms_txt',
            label: 'llms.txt',
            status: 'info',
            detail: 'The optional /llms.txt endpoint does not look like a markdown map. This is not a search eligibility requirement.',
          },
    )
  } else if (llms.status != null) {
    checks.push({
      id: 'llms_txt',
      label: 'llms.txt',
      status: 'info',
      detail: `Optional llms.txt not available (HTTP ${llms.status}). Google does not require AI text files or special markup for AI search features. No fix is required for its absence.`,
    })
  } else {
    checks.push({ id: 'llms_txt', label: 'llms.txt', status: 'unknown', detail: `/llms.txt didn't load (${llms.error ?? 'no answer'}).` })
  }

  // ---- sitemap
  const candidates = [...new Set([...sitemapHints, `${origin}/sitemap_index.xml`, `${origin}/sitemap.xml`, `${origin}/wp-sitemap.xml`])]
  let sitemapUrls: string[] | null = null
  let sitemapAt: string | null = null
  let sitemapWall: string | null = null
  for (const c of candidates) {
    const r = await grab(fetcher, c, timeoutMs)
    if (r.wall) {
      sitemapWall = r.wall
      continue
    }
    if (r.status !== 200 || !/<(urlset|sitemapindex)\b/i.test(r.body)) continue
    const top = parseSitemap(r.body)
    sitemapAt = c
    if (top.isIndex) {
      const urls: string[] = []
      for (const child of top.urls.slice(0, opts.maxChildSitemaps ?? 5)) {
        const cr = await grab(fetcher, child, timeoutMs)
        if (cr.status === 200 && !cr.wall) urls.push(...parseSitemap(cr.body).urls)
      }
      sitemapUrls = urls
    } else sitemapUrls = top.urls
    break
  }
  if (sitemapUrls) {
    const sus = suspiciousSitemapUrls(sitemapUrls)
    checks.push(
      sus.length
        ? {
            id: 'sitemap',
            label: 'Sitemap',
            status: 'warn',
            detail: `Sitemap (${sitemapAt}) lists ${sitemapUrls.length} pages, including ${sus.length} that look like tests or leftovers: ${sus.slice(0, 8).map((u) => new URL(u).pathname).join(', ')}${sus.length > 8 ? '…' : ''}.`,
            fix: wpFix(
              site,
              'For each page: edit it > Yoast box > Advanced > "Allow search engines to show this page in search results?" = No (or delete the test pages). Yoast drops noindexed pages from the sitemap.',
              'Remove these pages or mark them noindex.',
            ),
          }
        : { id: 'sitemap', label: 'Sitemap', status: 'pass', detail: `Sitemap (${sitemapAt}) lists ${sitemapUrls.length} pages; none look like test pages.` },
    )
  } else if (sitemapWall) {
    walls.push(sitemapWall)
    checks.push({ id: 'sitemap', label: 'Sitemap', status: 'unknown', detail: WALLED('the sitemap', sitemapWall) })
  } else {
    checks.push({
      id: 'sitemap',
      label: 'Sitemap',
      status: 'fail',
      detail: 'No XML sitemap found (robots.txt Sitemap line, /sitemap_index.xml, /sitemap.xml, /wp-sitemap.xml).',
      fix: wpFix(site, 'Yoast SEO > Settings > Site features > XML sitemaps: on.', 'Publish /sitemap.xml listing every public page and add a Sitemap: line to robots.txt.'),
    })
  }

  // ---- pages
  const paths = ['/', ...(site.pages ?? []).filter((p) => p && p !== '/')]
  let home: PageFacts | null = null
  const pages: Record<string, AuditPage> = {}
  for (const path of paths) {
    const url = `${origin}${path.startsWith('/') ? path : `/${path}`}`
    const r = await grab(fetcher, url, timeoutMs)
    if (r.wall) {
      walls.push(r.wall)
      checks.push({ id: 'page', label: 'Page loads', status: 'unknown', detail: WALLED(path, r.wall), page: path })
      continue
    }
    if (r.status !== 200) {
      checks.push({
        id: 'page',
        label: 'Page loads',
        status: r.status == null ? 'unknown' : 'fail',
        detail: r.status == null ? `Didn't load (${r.error ?? 'no answer'}).` : `HTTP ${r.status}.`,
        page: path,
      })
      continue
    }
    const f = parsePage(r.body)
    if (path === '/') home = f
    pages[path] = { url, title: f.title, description: f.description, canonical: f.canonical, h1: f.h1, schemaTypes: f.schemaTypes, monthlyPrice: f.monthlyPrice, wordCount: f.wordCount }
    checks.push(...pageChecks(site, path, url, f))
  }

  if (home) {
    const hasOrg = home.schemaTypes.some((t) => /^(Organization|Corporation|LocalBusiness|FinancialService)$/.test(t))
    checks.push(
      hasOrg
        ? { id: 'schema_org', label: 'Organization schema', status: 'pass', detail: `Home page declares ${home.schemaTypes.filter((t) => /Organization|Business|Service/.test(t)).join(', ')}.`, page: '/' }
        : {
            id: 'schema_org',
            label: 'Organization schema',
            status: 'warn',
            detail: 'Home page has no Organization schema (who you are, logo, social profiles) for search engines and AI to anchor on.',
            fix: wpFix(site, 'Yoast SEO > Settings > Site representation: choose Organization, add the name, logo and social profiles.', 'Add an Organization JSON-LD block (name, url, logo, sameAs).'),
            page: '/',
          },
    )
  }

  // ---- bot wall: the one finding that hides all the others from AI crawlers
  if (walls.length) {
    checks.unshift({
      id: 'bot_wall',
      label: 'Bot wall in front of the site',
      status: 'fail',
      detail: `${walls.length} of our requests got a ${walls[0]} instead of the page. This proves the audit encountered a challenge, not that verified search crawlers were blocked. Inspect host logs to determine their access.`,
      fix:
        (site.host ?? '').toLowerCase() === 'siteground'
          ? 'Check SiteGround access and security logs for verified Googlebot, Bingbot, PerplexityBot and OAI-SearchBot. Confirm challenges before requesting narrow search-crawler exceptions; preserve training opt-outs and security protections.'
          : 'Ask the host to verify search-crawler access and apply narrow exceptions only where challenges are confirmed.',
    })
  } else {
    checks.unshift({ id: 'bot_wall', label: 'Bot wall in front of the site', status: 'pass', detail: 'Every request got the real content (no captcha or challenge page).' })
  }

  // ---- PageSpeed (Google's free API; needs a free key)
  checks.push(await pagespeedCheck(fetcher, `${origin}/`, opts.pagespeedKey ?? null))
  return { checks, pages, sitemapUrls }
}

/** Boilerplate phrases that say nothing about who a page is for. */
export const GENERIC_COPY = [
  /take your business to the next level/i,
  /trusted payment processing solutions/i,
  /has you covered/i,
  /explore our (innovative|lucrative)/i,
  /\bhome new\b/i,
  /^home$/i,
]

function pageChecks(site: AuditSite, path: string, url: string, f: PageFacts): Check[] {
  const out: Check[] = []
  if (f.robotsMeta && /noindex/i.test(f.robotsMeta)) {
    out.push({ id: 'noindex', label: 'Indexing allowed', status: 'fail', detail: `robots meta says "${f.robotsMeta}".`, fix: wpFix(site, 'Edit the page > Yoast > Advanced > allow search engines = Yes.', 'Remove the noindex robots meta.'), page: path })
  }
  if (!f.title) out.push({ id: 'title', label: 'Title', status: 'fail', detail: 'No <title>.', fix: wpFix(site, 'Edit the page > Yoast > SEO title.', 'Add a title naming the audience and offer.'), page: path })
  else if (f.title.length > 65) out.push({ id: 'title', label: 'Title', status: 'warn', detail: `"${f.title}" is ${f.title.length} characters; Google cuts around 60.`, fix: 'Shorten it, keep the audience and offer up front.', page: path })
  else out.push({ id: 'title', label: 'Title', status: 'pass', detail: `"${f.title}"`, page: path })

  const generic = (s: string | null) => !!s && GENERIC_COPY.some((re) => re.test(s))
  if (f.title && generic(f.title)) out.push({ id: 'title_generic', label: 'Title wording', status: 'warn', detail: `"${f.title}" is generic; it doesn't say who the page is for.`, fix: wpFix(site, 'Edit the page > Yoast > SEO title: audience + offer, e.g. "Card Processing for Contractors | TapDash".', 'Rewrite the title to name the audience and offer.'), page: path })
  if (f.description && generic(f.description)) out.push({ id: 'description_generic', label: 'Description wording', status: 'warn', detail: `"${f.description.slice(0, 140)}" is generic boilerplate.`, fix: wpFix(site, 'Edit the page > Yoast > Meta description: who it is for, what it costs, why it is different.', 'Rewrite the description: audience, price, difference.'), page: path })
  if (!f.description) out.push({ id: 'description', label: 'Meta description', status: 'warn', detail: 'No meta description; search engines and AI tools improvise one.', fix: wpFix(site, 'Edit the page > Yoast > Meta description: one sentence on who it is for and what it costs.', 'Add a meta description.'), page: path })
  else out.push({ id: 'description', label: 'Meta description', status: 'pass', detail: `"${f.description.slice(0, 160)}"`, page: path })

  if (f.h1.length === 0) out.push({ id: 'h1', label: 'Main heading (H1)', status: 'warn', detail: 'No H1 heading on the page.', fix: wpFix(site, 'In the page editor, make the main headline a Heading 1 block (H1) that says who it is for.', 'Make the main headline an <h1>.'), page: path })
  else if (f.h1.length > 1) out.push({ id: 'h1', label: 'Main heading (H1)', status: 'warn', detail: `${f.h1.length} H1 headings: ${f.h1.slice(0, 3).map((h) => `"${h}"`).join(', ')}.`, fix: 'Keep one H1; make the rest H2.', page: path })
  else out.push({ id: 'h1', label: 'Main heading (H1)', status: 'pass', detail: `"${f.h1[0]}"`, page: path })

  if (!f.canonical) {
    out.push({ id: 'canonical', label: 'Canonical URL', status: 'warn', detail: 'No canonical tag.', fix: wpFix(site, 'Yoast sets it automatically; check that the page is not excluded.', 'Add <link rel="canonical" href="..."> with the page\'s own URL.'), page: path })
  } else {
    let same = false
    try {
      const c = new URL(f.canonical, url)
      const u = new URL(url)
      same = c.host.toLowerCase() === u.host.toLowerCase() && c.pathname.replace(/\/$/, '') === u.pathname.replace(/\/$/, '')
      if (!same && hostKey(c.host) === hostKey(u.host) && c.pathname.replace(/\/$/, '') === u.pathname.replace(/\/$/, '')) {
        out.push({ id: 'canonical', label: 'Canonical URL', status: 'warn', detail: `Canonical points to ${f.canonical} (a different host form than the page, ${u.host}).`, fix: wpFix(site, `Edit the page > Yoast > Advanced > Canonical URL: set it to ${u.protocol}//${u.host}${u.pathname} (or clear it).`, 'Point the canonical at the page\'s own URL.'), page: path })
        return finishSchema(site, path, f, out)
      }
    } catch {
      /* unparsable canonical */
    }
    out.push(
      same
        ? { id: 'canonical', label: 'Canonical URL', status: 'pass', detail: f.canonical, page: path }
        : { id: 'canonical', label: 'Canonical URL', status: 'warn', detail: `Canonical points elsewhere: ${f.canonical}.`, fix: 'Point the canonical at this page unless it is a deliberate duplicate.', page: path },
    )
  }
  return finishSchema(site, path, f, out)
}

function finishSchema(site: AuditSite, path: string, f: PageFacts, out: Check[]): Check[] {
  if (f.schemaErrors) out.push({ id: 'schema_valid', label: 'Schema parses', status: 'fail', detail: `${f.schemaErrors} JSON-LD block${f.schemaErrors === 1 ? '' : 's'} failed to parse.`, fix: 'Fix the broken JSON-LD (validator.schema.org shows where).', page: path })
  const faq = f.schemaTypes.includes('FAQPage')
  out.push(
    faq
      ? { id: 'schema_faq', label: 'FAQ schema', status: 'pass', detail: 'FAQPage schema present.', page: path }
      : {
          id: 'schema_faq',
          label: 'FAQ schema',
          status: f.hasFaqText ? 'warn' : 'info',
          detail: f.hasFaqText ? 'Visible FAQ text was detected without FAQPage schema. Markup is optional and does not guarantee citations or rich results.' : 'No FAQ section detected. Consider useful buyer answers only if the page needs them; do not add hidden or invented FAQ markup.',
          fix: 'Review actual buyer questions and visible page content first. Any FAQ markup must match the visible answers; Google FAQ rich-result eligibility is restricted.',
          page: path,
        },
  )
  const priced = f.schemaTypes.some((t) => /^(Offer|AggregateOffer|Product|Service|FinancialProduct|PriceSpecification|UnitPriceSpecification)$/.test(t))
  if (path !== '/') {
    out.push(
      priced
        ? { id: 'schema_offer', label: 'Offer / price schema', status: 'pass', detail: `Declares ${f.schemaTypes.filter((t) => /Offer|Product|Service|Price/.test(t)).join(', ')}.`, page: path }
        : {
            id: 'schema_offer',
            label: 'Offer / price schema',
            status: 'warn',
            detail: 'No Service/Product/Offer schema detected. Consider markup only for verified, visible offer details; it is not required for AI citations.',
            fix: wpFix(
              site,
              'Review a Service/Offer JSON-LD draft using only verified pricing and terms already visible on this page. Do not publish placeholder or unsupported values.',
              'Add Service or Product JSON-LD with an Offer (price, currency, billing period).',
            ),
            page: path,
          },
    )
  }
  if (f.wordCount < 300) out.push({ id: 'thin', label: 'Readable text', status: 'warn', detail: `Only ~${f.wordCount} words readable without JavaScript.`, fix: 'Make sure the main copy is in the HTML (server-rendered), not only drawn by JavaScript.', page: path })
  return out
}

export async function pagespeedCheck(fetcher: Fetcher, url: string, key: string | null): Promise<Check> {
  if (!key) {
    return {
      id: 'pagespeed',
      label: 'Mobile speed (PageSpeed)',
      status: 'unknown',
      detail: 'Not measured: set PAGESPEED_API_KEY (free key from a Google Cloud project; no billing). Key-less calls are refused when Google\'s shared quota runs out.',
    }
  }
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${encodeURIComponent(key)}`
  try {
    const r = await fetcher(api, { signal: AbortSignal.timeout(120000) })
    const text = await r.text()
    if (r.status !== 200) return { id: 'pagespeed', label: 'Mobile speed (PageSpeed)', status: 'unknown', detail: `PageSpeed API answered HTTP ${r.status}.` }
    const j = JSON.parse(text) as { lighthouseResult?: { categories?: { performance?: { score?: number | null } }; audits?: Record<string, { displayValue?: string }> } }
    const score = j.lighthouseResult?.categories?.performance?.score
    if (typeof score !== 'number') return { id: 'pagespeed', label: 'Mobile speed (PageSpeed)', status: 'unknown', detail: 'PageSpeed returned no performance score.' }
    const pct = Math.round(score * 100)
    const lcp = j.lighthouseResult?.audits?.['largest-contentful-paint']?.displayValue
    return {
      id: 'pagespeed',
      label: 'Mobile speed (PageSpeed)',
      status: pct >= 90 ? 'pass' : pct >= 50 ? 'warn' : 'fail',
      detail: `Mobile performance ${pct}/100${lcp ? `, largest paint ${lcp}` : ''} (Google PageSpeed Insights).`,
      fix: pct >= 90 ? undefined : 'SiteGround: turn on Speed Optimizer (free plugin) caching, image compression and lazy-load; remove unused plugins and heavy sliders.',
    }
  } catch (e) {
    return { id: 'pagespeed', label: 'Mobile speed (PageSpeed)', status: 'unknown', detail: `PageSpeed call failed: ${(e as Error).message}.` }
  }
}
