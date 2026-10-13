/**
 * Read-only Warmbly API client (TAP-118). Server-only: the API key never
 * reaches the browser.
 *
 * Read-only by construction: the only method is GET, and the key the dashboard
 * is meant to hold is a Warmbly "read only" preset key (READ_* permissions,
 * nothing that can send, add mailboxes or change campaigns). Warmbly answers
 * 403 "insufficient API key permissions" to anything else.
 *
 * Auth: `Authorization: Bearer <key>` on `<base>/v1/...` (Warmbly's own API
 * key snippet). The API shares the app's host by path routing.
 */
import type { WarmblyAllowance, WarmblyCampaign, WarmblyMailbox, WarmblyMe, WarmblyPage, WarmblyWarmupAnalytics } from './types.ts'

export class WarmblyError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'WarmblyError'
  }
}

export interface WarmblyClientOptions {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** "https://host/" or "https://host/v1" -> "https://host/v1". */
export function apiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

export class WarmblyClient {
  private readonly base: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: WarmblyClientOptions) {
    if (!opts.apiKey.trim()) throw new WarmblyError('Warmbly API key is empty.', null)
    this.base = apiBase(opts.baseUrl)
    this.apiKey = opts.apiKey.trim()
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  /** GET only. Query values that are undefined/null are dropped. */
  async get<T>(path: string, query: Record<string, string | number | undefined | null> = {}): Promise<T> {
    const url = new URL(this.base + (path.startsWith('/') ? path : `/${path}`))
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        signal: ctrl.signal,
        cache: 'no-store',
      })
    } catch (e) {
      const why = (e as Error).name === 'AbortError' ? `no answer within ${Math.round(this.timeoutMs / 1000)}s` : (e as Error).message
      throw new WarmblyError(`Couldn't reach Warmbly (${why}).`, null)
    } finally {
      clearTimeout(timer)
    }
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!res.ok) {
      const msg = body && typeof body === 'object' && 'message' in body ? String((body as { message: unknown }).message) : text.slice(0, 200)
      throw new WarmblyError(`Warmbly answered ${res.status}${msg ? `: ${msg}` : ''}`, res.status)
    }
    if (body === null) throw new WarmblyError('Warmbly answered with something that is not JSON.', res.status)
    return body as T
  }

  me(): Promise<WarmblyMe> {
    return this.get<WarmblyMe>('/me')
  }

  mailboxes(limit = 100): Promise<WarmblyPage<WarmblyMailbox>> {
    return this.get<WarmblyPage<WarmblyMailbox>>('/emails', { limit })
  }

  campaigns(limit = 100): Promise<WarmblyPage<WarmblyCampaign>> {
    return this.get<WarmblyPage<WarmblyCampaign>>('/campaigns', { limit })
  }

  /** Warm-up totals over [from, to] (YYYY-MM-DD), every mailbox. Warmbly requires both dates. */
  warmup(from: string, to: string): Promise<WarmblyWarmupAnalytics> {
    return this.get<WarmblyWarmupAnalytics>('/analytics/warmup', { from, to })
  }

  allowance(): Promise<WarmblyAllowance> {
    return this.get<WarmblyAllowance>('/emails/allowance')
  }
}
