/**
 * Why a fetch didn't give us the real resource, in plain words.
 *
 * Every audit fetch goes through `classifyFetch`. It never returns a blank
 * reason: a page we couldn't read says WHY (a named bot protection, access
 * denied, login, rate limit, geo block, server error, a network failure) so the
 * dashboard can show "Blocked: SiteGround captcha (HTTP 202)" instead of a
 * false "Fix" or a vague "couldn't check".
 *
 * - ok       the server answered with the content (2xx, no challenge)
 * - missing  a real 404/410 — the one failure that IS a site problem
 * - blocked  something stood between our checker and the page (bot wall, 401/403, 429, 451)
 * - error    the request failed for another reason (5xx, maintenance, timeout, DNS, TLS, ...)
 */

export type FetchClass = 'ok' | 'missing' | 'blocked' | 'error'
export type FetchKind =
  | 'ok'
  | 'not_found'
  | 'bot_protection'
  | 'access_denied'
  | 'login_required'
  | 'rate_limited'
  | 'geo_blocked'
  | 'server_error'
  | 'maintenance'
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'connection_refused'
  | 'connection_reset'
  | 'too_many_redirects'
  | 'network'
  | 'unexpected'

export interface FetchVerdict {
  status: FetchClass
  kind: FetchKind
  /** Short plain reason, shown verbatim in the UI. Never empty. */
  reason: string
  http_status: number | null
  /** The bot-protection vendor when we can tell (SiteGround, Cloudflare, ...). */
  provider: string | null
  /** Extra evidence (a header, the page title, the error code). */
  detail: string | null
}

export interface HeaderLike {
  get(name: string): string | null
}

export interface FetchFacts {
  status: number | null
  body?: string | null
  headers?: HeaderLike | Record<string, string | undefined> | null
  /** The thrown error when the request never got an answer. */
  error?: unknown
  /** Where the request ended after redirects. */
  finalUrl?: string | null
  requestedUrl?: string | null
  /** Milliseconds the request was allowed (for the timeout wording). */
  timeoutMs?: number
}

function headerGetter(h: FetchFacts['headers']): (name: string) => string {
  if (!h) return () => ''
  if (typeof (h as HeaderLike).get === 'function') {
    const g = h as HeaderLike
    return (n) => {
      try {
        return g.get(n) ?? ''
      } catch {
        return ''
      }
    }
  }
  const rec: Record<string, string> = {}
  for (const [k, v] of Object.entries(h as Record<string, string | undefined>)) if (v != null) rec[k.toLowerCase()] = String(v)
  return (n) => rec[n.toLowerCase()] ?? ''
}

const HTTP_WORDS: Record<number, string> = {
  500: 'internal server error',
  502: 'bad gateway',
  503: 'service unavailable',
  504: 'gateway timeout',
  520: 'unknown error from the origin',
  521: 'origin server is down',
  522: 'origin connection timed out',
  523: 'origin unreachable',
  524: 'origin timed out',
  525: 'SSL handshake with the origin failed',
  526: 'invalid SSL certificate at the origin',
  530: 'origin DNS error',
}

function pageTitle(body: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)
  const t = m ? m[1].replace(/\s+/g, ' ').trim() : ''
  return t || null
}

/** First ~120 chars of the page's title, else its visible text, so an unknown answer is never blank. */
export function snippet(body: string, max = 120): string {
  const t = pageTitle(body)
  const text = (t ?? body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  if (!text) return '(empty page)'
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

interface Wall {
  provider: string
  what: string
}

/**
 * Bot-protection fingerprints. `strong` markers only ever appear on a challenge
 * page, so they count at any status; weak markers (a vendor's cookie, a generic
 * "captcha") only count when the status already says we were not served.
 */
function detectWall(status: number | null, body: string, h: (n: string) => string): Wall | null {
  const b = body.slice(0, 20000)
  const low = b.toLowerCase()
  const server = h('server').toLowerCase()
  const cookies = h('set-cookie').toLowerCase()
  // Statuses a challenge or firewall answers with (not 404: a normal 404 page may carry a form captcha).
  const notServed = status == null || [202, 401, 403, 405, 406, 409, 429, 503].includes(status)
  const title = (pageTitle(b) ?? '').toLowerCase()

  // SiteGround: meta-refresh to /.well-known/sgcaptcha/, the sg-captcha header, or the challenge text.
  if (/\/\.well-known\/sgcaptcha\//.test(b) || h('sg-captcha') || /checking the site connection security/i.test(b)) return { provider: 'SiteGround', what: 'captcha' }
  // Cloudflare: cf-mitigated header, or the interstitial ("Just a moment...", cf-chl).
  if (h('cf-mitigated').toLowerCase() === 'challenge') return { provider: 'Cloudflare', what: 'challenge' }
  if (title === 'just a moment...' || /cf-chl-|_cf_chl_opt|cf-browser-verification/.test(b)) return { provider: 'Cloudflare', what: 'challenge' }
  if (notServed && (/attention required! \| cloudflare/.test(title) || /cloudflare ray id|cf-error-details|challenge-platform/.test(low))) {
    return { provider: 'Cloudflare', what: /captcha|challenge/.test(low) ? 'challenge' : 'firewall block' }
  }
  // Sucuri
  if (h('x-sucuri-block') || (notServed && (h('x-sucuri-id') || /sucuri website firewall/i.test(b)))) return { provider: 'Sucuri', what: 'firewall block' }
  // Imperva / Incapsula
  if (/incapsula incident/i.test(b) || (notServed && (/_incapsula_resource/i.test(b) || h('x-iinfo') || /incap_ses|visid_incap/.test(cookies)))) return { provider: 'Imperva', what: 'bot challenge' }
  // DataDome
  if (/captcha-delivery\.com|geo\.captcha-delivery/i.test(b) || (notServed && (h('x-datadome') || h('x-dd-b') || /datadome=/.test(cookies)))) return { provider: 'DataDome', what: 'captcha' }
  // PerimeterX / HUMAN
  if (/px-captcha/i.test(b) || (notServed && (/_pxappid|perimeterx/i.test(b) || /_pxhd=|_px3=/.test(cookies)))) return { provider: 'PerimeterX', what: 'captcha' }
  // Akamai
  if (notServed && (/akamaighost/.test(server) || h('akamai-grn') || (/access denied/i.test(b) && /reference\s*#\d/i.test(b)) || /errors\.edgesuite\.net/i.test(b))) return { provider: 'Akamai', what: 'bot block' }
  // AWS WAF
  if (h('x-amzn-waf-action') || (notServed && /awswaf|aws-waf-token/i.test(b))) return { provider: 'AWS WAF', what: 'challenge' }
  // Wordfence (WordPress security plugin)
  if (notServed && /wordfence/i.test(b)) return { provider: 'Wordfence', what: 'firewall block' }
  // Vercel's own bot protection
  if (h('x-vercel-mitigated') === 'challenge') return { provider: 'Vercel', what: 'challenge' }
  // Generic captcha / are-you-human page
  if (notServed && /captcha|recaptcha|hcaptcha|turnstile|are you a (robot|human)|verify you are (a )?human|bot (check|protection|detection)/i.test(b)) return { provider: 'bot protection', what: 'captcha' }
  // A 202 whose whole body is a meta refresh: a redirect-to-challenge page.
  if (status === 202 && b.length < 800 && /http-equiv=["']?refresh/i.test(b)) return { provider: 'bot protection', what: 'redirect-to-challenge page' }
  return null
}

const LOGIN_PATH = /(\/wp-login\.php|\/login\b|\/log-in\b|\/signin\b|\/sign-in\b|\/sso\/|\/oauth\/|\/auth\/|\/account\/login)/i
const GEO_WORDS = /not available in your (country|region|location)|not available in your area|unavailable in your (country|region)|geo-?block|access from your (country|region|location) (is|has been) (blocked|denied|restricted)/i
const MAINTENANCE_WORDS = /maintenance mode|under maintenance|scheduled maintenance|briefly unavailable for scheduled maintenance|we'll be back soon|be right back/i

function retryAfterWords(v: string, now: Date): string | null {
  const s = v.trim()
  if (!s) return null
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n >= 120 ? `retry in ${Math.round(n / 60)} min` : `retry in ${n}s`
  }
  const t = Date.parse(s)
  if (!Number.isNaN(t)) {
    const sec = Math.max(0, Math.round((t - now.getTime()) / 1000))
    return sec >= 120 ? `retry in ${Math.round(sec / 60)} min` : `retry in ${sec}s`
  }
  return null
}

function errorFacts(e: unknown): { name: string; code: string; message: string } {
  const parts: string[] = []
  let code = ''
  let name = ''
  let cur: unknown = e
  for (let i = 0; i < 5 && cur; i++) {
    const o = cur as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown }
    if (!name && typeof o.name === 'string') name = o.name
    if (typeof o.name === 'string' && /timeout|abort/i.test(o.name)) name = o.name
    if (!code && typeof o.code === 'string') code = o.code
    if (typeof o.message === 'string') parts.push(o.message)
    else if (typeof cur === 'string') parts.push(cur)
    cur = o.cause
  }
  return { name, code, message: parts.join(' | ') }
}

function networkVerdict(e: unknown, timeoutMs?: number): FetchVerdict {
  const { name, code, message } = errorFacts(e)
  const all = `${name} ${code} ${message}`
  const v = (kind: FetchKind, reason: string): FetchVerdict => ({ status: 'error', kind, reason, http_status: null, provider: null, detail: [code, message].filter(Boolean).join(': ') || null })
  if (/TimeoutError|AbortError|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|timed? ?out|aborted due to timeout/i.test(all)) {
    return v('timeout', `Couldn't reach: timed out${timeoutMs ? ` after ${Math.round(timeoutMs / 1000)}s` : ''}`)
  }
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME|getaddrinfo|dns/i.test(all)) return v('dns', "Couldn't reach: DNS lookup failed (the domain didn't resolve)")
  if (/CERT|SSL|TLS|self[- ]signed|UNABLE_TO_VERIFY|ERR_TLS|EPROTO|certificate/i.test(all)) return v('tls', "Couldn't reach: SSL/TLS certificate error")
  if (/ECONNREFUSED|connection refused/i.test(all)) return v('connection_refused', "Couldn't reach: connection refused")
  if (/ECONNRESET|socket hang up|other side closed|UND_ERR_SOCKET|connection reset/i.test(all)) return v('connection_reset', "Couldn't reach: connection reset by the server")
  if (/redirect count exceeded|too many redirects|maximum redirect/i.test(all)) return v('too_many_redirects', "Couldn't reach: too many redirects")
  if (/EHOSTUNREACH|ENETUNREACH/i.test(all)) return v('network', "Couldn't reach: host unreachable")
  return v('network', `Couldn't reach: ${(code || message || name || 'no answer').slice(0, 120)}`)
}

/** Classify one fetch outcome. Pure; `now` only feeds the Retry-After wording. */
export function classifyFetch(f: FetchFacts, now: Date = new Date()): FetchVerdict {
  if (f.status == null) return networkVerdict(f.error ?? 'no answer', f.timeoutMs)
  const status = f.status
  const body = f.body ?? ''
  const h = headerGetter(f.headers)
  const mk = (cls: FetchClass, kind: FetchKind, reason: string, provider: string | null = null, detail: string | null = null): FetchVerdict => ({ status: cls, kind, reason, http_status: status, provider, detail })

  const wall = detectWall(status, body, h)
  if (wall) {
    const label = wall.provider === 'bot protection' ? `bot protection ${wall.what}` : `${wall.provider} ${wall.what}`
    return mk('blocked', 'bot_protection', `Blocked: ${label} (HTTP ${status})`, wall.provider === 'bot protection' ? null : wall.provider, h('server') ? `server: ${h('server')}` : null)
  }

  // Ended on a login page we didn't ask for.
  const final = f.finalUrl ?? ''
  const asked = f.requestedUrl ?? ''
  let loginRedirect = false
  try {
    if (final && asked && final !== asked) loginRedirect = LOGIN_PATH.test(new URL(final).pathname) && !LOGIN_PATH.test(new URL(asked).pathname)
  } catch {
    /* unparsable */
  }
  if (status === 401 || status === 407 || loginRedirect) {
    return mk('blocked', 'login_required', loginRedirect ? `Blocked: login required (redirected to ${new URL(final).pathname})` : `Blocked: login required (HTTP ${status})`, null, h('www-authenticate') ? `www-authenticate: ${h('www-authenticate')}` : null)
  }
  if (status === 451 || ((status === 403 || status === 404) && GEO_WORDS.test(body.slice(0, 20000)))) {
    return mk('blocked', 'geo_blocked', `Blocked: not available in the checker's region (HTTP ${status})`)
  }
  if (status === 429) {
    const ra = retryAfterWords(h('retry-after'), now)
    return mk('blocked', 'rate_limited', `Rate limited (HTTP 429${ra ? `, ${ra}` : ''})`, null, h('retry-after') ? `retry-after: ${h('retry-after')}` : null)
  }
  if (status === 403) return mk('blocked', 'access_denied', 'Blocked: server refused access (HTTP 403)', null, `page says: ${snippet(body)}`)
  if (status === 404 || status === 410) return mk('missing', 'not_found', `Not found (HTTP ${status})`)
  if (status >= 500) {
    if (MAINTENANCE_WORDS.test(body.slice(0, 20000))) return mk('error', 'maintenance', `Site in maintenance mode (HTTP ${status})`)
    const words = HTTP_WORDS[status]
    return mk('error', 'server_error', `Server error: ${words ?? 'the server failed'} (HTTP ${status})`, null, `page says: ${snippet(body)}`)
  }
  if (status >= 200 && status < 300) return mk('ok', 'ok', `OK (HTTP ${status})`)
  if (status >= 300 && status < 400) {
    const loc = h('location')
    return mk('error', 'unexpected', `Unexpected redirect (HTTP ${status}${loc ? ` to ${loc.slice(0, 100)}` : ''})`)
  }
  return mk('error', 'unexpected', `Unexpected answer (HTTP ${status}): “${snippet(body)}”`)
}
