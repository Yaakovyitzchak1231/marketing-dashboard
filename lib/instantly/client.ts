/**
 * Server-only client for the Instantly API v2 (https://developer.instantly.ai/api-reference).
 *
 * - Base URL https://api.instantly.ai/api/v2, `Authorization: Bearer $INSTANTLY_API_KEY`.
 * - Per-request timeout, retry with exponential backoff on 429 / 5xx / network
 *   errors (honouring Retry-After), never on other 4xx.
 * - Cursor pagination (`limit` + `starting_after`, follow `next_starting_after`)
 *   until the API stops returning a cursor. Hitting the page cap is reported as
 *   `truncated: true`, never silently dropped.
 * - Caching: GETs ask Next for `revalidate: 300` under the INSTANTLY_CACHE_TAG
 *   tag (a new reply clears it, see the webhook route) and are memoised
 *   in-process for 30 s, which de-duplicates the concurrent identical calls one
 *   dashboard load makes. POSTs are memoised in-process for 5 minutes.
 * - Errors become InstantlyError with plain words and NO key in them.
 *
 * Read-only by construction: the only verbs this client sends are GET and
 * POST to read-only list endpoints in READ_ONLY_POSTS.
 */
import 'server-only'

export const INSTANTLY_BASE_URL = 'https://api.instantly.ai/api/v2'
export const CACHE_SECONDS = 300
/** Next fetch-cache tag on every Instantly GET; revalidateTag() on it forces fresh reads everywhere. */
export const INSTANTLY_CACHE_TAG = 'instantly'
/** GETs are backed by the shared Next cache, so the per-process memo only needs to cover one load. */
const GET_MEMO_MS = 30_000
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_RETRIES = 3

/** POST endpoints that only read. Anything else is refused before it leaves the box. */
export const READ_ONLY_POSTS = new Set<string>(['/leads/list'])

export type QueryValue = string | number | boolean | null | undefined | string[]
export type Query = Record<string, QueryValue>

export class InstantlyError extends Error {
  readonly status: number | null
  readonly path: string
  constructor(message: string, path: string, status: number | null) {
    super(message)
    this.name = 'InstantlyError'
    this.status = status
    this.path = path
  }
}

export interface ClientOptions {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  retries?: number
  /** Base backoff in ms (doubles each retry). Tests pass 0. */
  backoffMs?: number
  /** In-process memo TTL in ms (GETs: at most 30 s); 0 disables. */
  memoTtlMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface Page<T> {
  items: T[]
  /** true when the page cap stopped us before the API ran out of pages. */
  truncated: boolean
  pages: number
}

type MemoEntry = { at: number; value: Promise<unknown> }
const MEMO = new Map<string, MemoEntry>()

/** Forget every memoised response in this process (tests; the webhook route after a reply). */
export function clearInstantlyMemo(): void {
  MEMO.clear()
}

export function buildQueryString(query: Query | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) {
      if (v.length) params.set(k, v.join(','))
    } else {
      params.set(k, String(v))
    }
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

/** Human words for an HTTP failure. Never includes headers or the key. */
export function describeStatus(status: number, path: string, apiMessage?: string): string {
  const detail = apiMessage ? ` (${apiMessage.slice(0, 200)})` : ''
  if (status === 401) return `Instantly rejected the API key for ${path}. Check INSTANTLY_API_KEY.`
  if (status === 403) return `The Instantly API key is not allowed to read ${path}. Give it the all:read scope.`
  if (status === 404) return `Instantly has no ${path} endpoint for this workspace${detail}.`
  if (status === 413) return `Instantly said the request to ${path} was too large${detail}.`
  if (status === 429) return `Instantly rate-limited ${path}; tried again and it was still busy.`
  if (status >= 500) return `Instantly had a server error on ${path} (HTTP ${status}).`
  return `Instantly refused ${path} (HTTP ${status})${detail}.`
}

function scrub(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join('[redacted]') : text
}

export class InstantlyClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly backoffMs: number
  private readonly memoTtlMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: ClientOptions) {
    if (!opts.apiKey) throw new Error('InstantlyClient needs an API key')
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? INSTANTLY_BASE_URL).replace(/\/$/, '')
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retries = opts.retries ?? DEFAULT_RETRIES
    this.backoffMs = opts.backoffMs ?? 500
    this.memoTtlMs = opts.memoTtlMs ?? CACHE_SECONDS * 1000
    this.now = opts.now ?? (() => Date.now())
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, query)
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, undefined, body)
  }

  private request<T>(method: 'GET' | 'POST', path: string, query?: Query, body?: unknown): Promise<T> {
    if (method === 'POST' && !READ_ONLY_POSTS.has(path)) {
      return Promise.reject(new InstantlyError(`Refusing to POST to ${path}: the dashboard is read-only.`, path, null))
    }
    const url = `${this.baseUrl}${path}${buildQueryString(query)}`
    // The key's last 6 chars keep two workspaces apart in one process without storing the key in the memo key.
    const memoKey = `${this.apiKey.slice(-6)}|${method}|${url}|${body === undefined ? '' : JSON.stringify(body)}`
    const ttl = method === 'GET' ? Math.min(this.memoTtlMs, GET_MEMO_MS) : this.memoTtlMs
    if (ttl > 0) {
      const hit = MEMO.get(memoKey)
      if (hit && this.now() - hit.at < ttl) return hit.value as Promise<T>
    }
    const p = this.send<T>(method, path, url, body)
    if (ttl > 0) {
      MEMO.set(memoKey, { at: this.now(), value: p })
      // Never cache a failure.
      p.catch(() => {
        if (MEMO.get(memoKey)?.value === p) MEMO.delete(memoKey)
      })
    }
    return p
  }

  private async send<T>(method: 'GET' | 'POST', path: string, url: string, body?: unknown): Promise<T> {
    let lastError: InstantlyError | null = null
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        const retryAfter = lastError && (lastError as InstantlyError & { retryAfterMs?: number }).retryAfterMs
        const wait = retryAfter ?? this.backoffMs * 2 ** (attempt - 1)
        await this.sleep(Math.min(wait, 10_000))
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      let res: Response
      try {
        const init: RequestInit & { next?: { revalidate: number; tags?: string[] } } = {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        }
        if (method === 'GET') init.next = { revalidate: CACHE_SECONDS, tags: [INSTANTLY_CACHE_TAG] }
        else init.cache = 'no-store'
        res = await this.fetchImpl(url, init)
      } catch (err) {
        clearTimeout(timer)
        const aborted = (err as { name?: string })?.name === 'AbortError'
        lastError = new InstantlyError(
          aborted
            ? `Instantly did not answer ${path} within ${Math.round(this.timeoutMs / 1000)}s.`
            : `Could not reach Instantly for ${path} (${scrub(String((err as Error)?.message ?? err), this.apiKey).slice(0, 120)}).`,
          path,
          null,
        )
        continue
      }
      clearTimeout(timer)
      if (res.ok) {
        const text = await res.text()
        if (!text) return null as T
        try {
          return JSON.parse(text) as T
        } catch {
          throw new InstantlyError(`Instantly sent something that is not JSON for ${path}.`, path, res.status)
        }
      }
      let apiMessage: string | undefined
      try {
        const j = (await res.json()) as { message?: unknown; error?: unknown }
        const m = typeof j?.message === 'string' ? j.message : typeof j?.error === 'string' ? j.error : undefined
        apiMessage = m ? scrub(m, this.apiKey) : undefined
      } catch {
        /* body not JSON */
      }
      const err = new InstantlyError(describeStatus(res.status, path, apiMessage), path, res.status)
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'))
        if (Number.isFinite(ra) && ra > 0) (err as InstantlyError & { retryAfterMs?: number }).retryAfterMs = ra * 1000
        lastError = err
        continue
      }
      throw err
    }
    throw lastError ?? new InstantlyError(`Instantly request to ${path} failed.`, path, null)
  }

  /**
   * Follows `next_starting_after` until the API stops sending one (or sends an
   * empty page, or repeats a cursor). Stops at `maxPages` and says so.
   */
  async paginate<T>(
    path: string,
    opts: { query?: Query; body?: Record<string, unknown>; method?: 'GET' | 'POST'; limit?: number; maxPages?: number } = {},
  ): Promise<Page<T>> {
    const method = opts.method ?? 'GET'
    const limit = opts.limit ?? 100
    const maxPages = opts.maxPages ?? 50
    const items: T[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    while (true) {
      if (pages >= maxPages) return { items, truncated: true, pages }
      type Resp = { items?: T[]; next_starting_after?: string | null }
      const resp: Resp =
        method === 'GET'
          ? await this.get<Resp>(path, { ...opts.query, limit, starting_after: cursor })
          : await this.post<Resp>(path, { ...opts.body, limit, ...(cursor ? { starting_after: cursor } : {}) })
      pages++
      const pageItems = Array.isArray(resp?.items) ? resp.items : []
      items.push(...pageItems)
      const next = resp?.next_starting_after
      if (!next || pageItems.length === 0 || seen.has(next)) return { items, truncated: false, pages }
      seen.add(next)
      cursor = next
    }
  }
}

/** The client for this deployment, or null when INSTANTLY_API_KEY is not set. */
export function clientFromEnv(env: Record<string, string | undefined> = process.env): InstantlyClient | null {
  const key = env.INSTANTLY_API_KEY?.trim()
  if (!key) return null
  return new InstantlyClient({ apiKey: key })
}

/**
 * The settings-aware client: a key saved on /settings wins, falling back to
 * INSTANTLY_API_KEY when nothing is saved — so an env-only deployment keeps
 * working exactly as it does today, and saving a key on /settings takes effect
 * immediately with no redeploy (lib/settings/store.ts's resolveConfig reaches
 * the database itself, the same way clientFromEnv reaches process.env itself).
 */
export async function clientFromConfig(env: Record<string, string | undefined> = process.env): Promise<InstantlyClient | null> {
  const { resolveConfig } = await import('../settings/store.ts')
  const { value } = await resolveConfig('instantly.api_key', env)
  if (value) return new InstantlyClient({ apiKey: value })
  return null
}
