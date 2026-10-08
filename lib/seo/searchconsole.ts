import { createSign } from 'node:crypto'

/**
 * Google Search Console (free API) through a service account, and Bing
 * Webmaster Tools (free API key). Server-only. Nothing is shown until the
 * env vars exist; then the numbers are Google's / Bing's own, as returned.
 *
 * GSC_CLIENT_EMAIL  service account email (add it as a user on the Search Console property)
 * GSC_PRIVATE_KEY   its private key (PEM; literal \n is accepted)
 * GSC_SITE_URL      the property, e.g. sc-domain:tapdash.co or https://tapdash.co/
 * BING_WEBMASTER_API_KEY, BING_SITE_URL (e.g. https://tapdash.co/)
 */

export interface GscConfig {
  clientEmail: string
  privateKey: string
  siteUrl: string
}

export function gscConfigFromEnv(env: Record<string, string | undefined> = process.env): GscConfig | null {
  const clientEmail = env.GSC_CLIENT_EMAIL?.trim()
  const privateKey = env.GSC_PRIVATE_KEY?.replace(/\\n/g, '\n').trim()
  const siteUrl = env.GSC_SITE_URL?.trim()
  if (!clientEmail || !privateKey || !siteUrl) return null
  return { clientEmail, privateKey, siteUrl }
}

export type JsonFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number
  text(): Promise<string>
}>

const b64url = (b: Buffer | string) => (typeof b === 'string' ? Buffer.from(b, 'utf8') : b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

export function signJwt(cfg: GscConfig, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(
    JSON.stringify({
      iss: cfg.clientEmail,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  )
  const s = createSign('RSA-SHA256')
  s.update(`${header}.${claims}`)
  return `${header}.${claims}.${b64url(s.sign(cfg.privateKey))}`
}

async function readJson(r: { status: number; text(): Promise<string> }, what: string): Promise<unknown> {
  const t = await r.text()
  let j: unknown = null
  try {
    j = JSON.parse(t)
  } catch {
    /* ignore */
  }
  if (r.status < 200 || r.status >= 300) {
    const e = j as { error?: { message?: string } | string; error_description?: string } | null
    const msg = e?.error_description ?? (typeof e?.error === 'string' ? e.error : e?.error?.message)
    throw new Error(`${what} answered HTTP ${r.status}${msg ? `: ${msg}` : ''}`)
  }
  return j
}

export interface GscRow {
  key: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}
export interface GscReport {
  startDate: string
  endDate: string
  queries: GscRow[]
  pages: GscRow[]
}

const ymd = (d: Date) => d.toISOString().slice(0, 10)

export async function gscReport(cfg: GscConfig, opts: { fetcher?: JsonFetch; now?: Date; days?: number } = {}): Promise<GscReport> {
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as JsonFetch)
  const now = opts.now ?? new Date()
  const tok = (await readJson(
    await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(cfg, Math.floor(now.getTime() / 1000)) }).toString(),
      signal: AbortSignal.timeout(20000),
    }),
    'Google sign-in',
  )) as { access_token?: string }
  if (!tok.access_token) throw new Error('Google sign-in returned no access token')
  // Search Console data lags ~2-3 days.
  const end = new Date(now.getTime() - 3 * 86400000)
  const start = new Date(end.getTime() - ((opts.days ?? 28) - 1) * 86400000)
  const q = async (dimension: 'query' | 'page'): Promise<GscRow[]> => {
    const j = (await readJson(
      await fetcher(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(cfg.siteUrl)}/searchAnalytics/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: ymd(start), endDate: ymd(end), dimensions: [dimension], rowLimit: 25 }),
        signal: AbortSignal.timeout(30000),
      }),
      'Search Console',
    )) as { rows?: { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }[] }
    return (j.rows ?? []).map((r) => ({ key: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }))
  }
  const [queries, pages] = await Promise.all([q('query'), q('page')])
  return { startDate: ymd(start), endDate: ymd(end), queries, pages }
}

export interface BingConfig {
  apiKey: string
  siteUrl: string
}
export function bingConfigFromEnv(env: Record<string, string | undefined> = process.env): BingConfig | null {
  const apiKey = env.BING_WEBMASTER_API_KEY?.trim()
  const siteUrl = env.BING_SITE_URL?.trim()
  return apiKey && siteUrl ? { apiKey, siteUrl } : null
}

export async function bingQueries(cfg: BingConfig, opts: { fetcher?: JsonFetch } = {}): Promise<GscRow[]> {
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as JsonFetch)
  const url = `https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=${encodeURIComponent(cfg.siteUrl)}&apikey=${encodeURIComponent(cfg.apiKey)}`
  const j = (await readJson(await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) }), 'Bing Webmaster')) as {
    d?: { Query?: string; Clicks?: number; Impressions?: number; AvgImpressionPosition?: number }[]
  }
  const agg = new Map<string, GscRow>()
  for (const r of j.d ?? []) {
    const k = r.Query ?? ''
    const cur = agg.get(k) ?? { key: k, clicks: 0, impressions: 0, ctr: 0, position: 0 }
    cur.clicks += r.Clicks ?? 0
    cur.impressions += r.Impressions ?? 0
    cur.position = r.AvgImpressionPosition ?? cur.position
    agg.set(k, cur)
  }
  return [...agg.values()]
    .map((r) => ({ ...r, ctr: r.impressions ? r.clicks / r.impressions : 0 }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 25)
}
