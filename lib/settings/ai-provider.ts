/**
 * The one guarded path to the configured AI provider (ai.base_url / AI_BASE_URL).
 * Every provider fetch — campaign-profile suggestions, segment "Describe it",
 * the /settings model list — goes through providerFetch():
 *  - the base URL must pass validatePublicHttpsUrl (DB value or env fallback alike);
 *  - the request is made with node:https and a custom `lookup` (createGuardedLookup) that
 *    resolves the host, refuses any private answer and hands back the very address it
 *    checked, so the socket connects to exactly the validated IP (no second DNS resolution
 *    = no DNS-rebinding window between "check" and "connect");
 *  - redirects are never followed (a 3xx could point at a private host);
 *  - error bodies are never shown or logged: callers get the HTTP status, and the server
 *    log gets only the status and a fixed reason code.
 */
import { resolveConfig } from './store.ts'
import { request as httpsRequest } from 'node:https'
import { assertPublicHost, BlockedAddressError, createGuardedLookup, validatePublicHttpsUrl } from './safe-url.ts'

export interface AiProviderConfig {
  baseUrl: string
  apiKey: string | null
  model: string
}

export type Lookup = NonNullable<Parameters<typeof assertPublicHost>[1]>

export class AiProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiProviderError'
  }
}

/** The AI config, or why there is none. A base URL (DB or env) that fails the SSRF guard counts as not configured. */
export async function resolveAiProviderConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<{ cfg: AiProviderConfig; reason?: undefined } | { cfg: null; reason: string }> {
  // Sequential on purpose: one pooled connection may serve all three reads.
  const b = await resolveConfig('ai.base_url', env)
  const m = await resolveConfig('ai.model', env)
  const k = await resolveConfig('ai.api_key', env)
  const baseUrl = b.value?.trim()
  const model = m.value?.trim()
  if (!baseUrl || !model) return { cfg: null, reason: 'no AI provider is configured (set the AI base URL and model in Settings, or AI_BASE_URL / AI_MODEL)' }
  const bad = validatePublicHttpsUrl(baseUrl)
  if (bad) return { cfg: null, reason: `the AI provider base URL is not allowed: ${bad}` }
  return { cfg: { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: k.value?.trim() || null, model } }
}

export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>

const MAX_REPLY_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })

/**
 * The production transport: node:https with the guarded `lookup`, no agent pooling, no redirect
 * following (a 3xx is returned as-is), a total timeout, and a size cap on the reply.
 * Exported for tests only; callers use providerFetch / providerRequest.
 */
export function pinnedHttpsFetch(
  url: string,
  init: RequestInit,
  opts: { lookup?: Lookup; timeoutMs?: number } = {},
): Promise<Response> {
  const u = new URL(url)
  const guarded = createGuardedLookup(opts.lookup)
  return new Promise<Response>((resolve, reject) => {
    const signal = init.signal ?? null
    if (signal?.aborted) return reject(abortError())
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v
    })
    const body = typeof init.body === 'string' ? init.body : null
    if (body !== null) headers['content-length'] = String(Buffer.byteLength(body))
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers,
        agent: false,
        lookup: guarded as never,
      },
      (res) => {
        const chunks: Uint8Array[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_REPLY_BYTES) {
            done(() => reject(new AiProviderError('The AI provider reply was too large.')))
            req.destroy()
            return
          }
          chunks.push(c as unknown as Uint8Array)
        })
        res.on('end', () =>
          done(() => {
            const status = res.statusCode ?? 0
            // Node's parser takes any 3-digit status; Response only 200-599. Never let the
            // RangeError escape this listener (it would be uncaught and leave the promise open).
            if (status < 200 || status > 599) return reject(new AiProviderError(`The AI provider answered with an invalid status (${status}).`))
            try {
              const rh = new Headers()
              for (const [k, v] of Object.entries(res.headers)) {
                if (v === undefined) continue
                try {
                  for (const x of Array.isArray(v) ? v : [v]) rh.append(k, x)
                } catch {
                  // a header value fetch's Headers refuses: not needed here
                }
              }
              const nullBody = status === 204 || status === 205 || status === 304
              resolve(new Response(nullBody ? null : new Uint8Array(Buffer.concat(chunks as unknown as readonly Uint8Array[])), { status, headers: rh }))
            } catch {
              reject(new AiProviderError('Could not read the AI provider reply.'))
            }
          }),
        )
        res.on('error', (e) => done(() => reject(e)))
      },
    )
    const onAbort = () => {
      done(() => reject(abortError()))
      req.destroy()
    }
    const timer = setTimeout(onAbort, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('error', (e) => done(() => reject(e)))
    if (body !== null) req.write(body)
    req.end()
  })
}

const SAFE_CODE = /^[A-Z0-9_]{3,32}$/

/**
 * Send one request to a provider URL with the SSRF guard and no redirects, returning the Response
 * for ANY non-redirect status (the caller decides what a 4xx means). Throws AiProviderError with a
 * person-safe message for: a disallowed URL, a private DNS answer, a redirect, or no answer.
 * `deps.fetchImpl` is a test seam: when given, the DNS check is a pre-flight against `deps.lookup`;
 * production never passes it and always gets the pinned transport.
 */
export async function providerRequest(
  url: string,
  init: RequestInit,
  deps: { fetchImpl?: ProviderFetch; lookup?: Lookup; timeoutMs?: number } = {},
): Promise<Response> {
  if (validatePublicHttpsUrl(url)) throw new AiProviderError('The AI provider base URL is not allowed.')
  let res: Response
  try {
    if (deps.fetchImpl) {
      await assertPublicHost(url, deps.lookup)
      res = await deps.fetchImpl(url, { ...init, redirect: 'manual' })
    } else {
      res = await pinnedHttpsFetch(url, { ...init, redirect: 'manual' }, { lookup: deps.lookup, timeoutMs: deps.timeoutMs })
    }
  } catch (e) {
    if (e instanceof AiProviderError) throw e
    if (e instanceof BlockedAddressError) throw new AiProviderError(e.message)
    if (e instanceof Error && e.name === 'AbortError') throw e
    const code = (e as { code?: unknown })?.code
    // Fixed reason code only: the raw error text can carry the resolved internal address.
    console.error('AI provider unreachable', { reason: 'unreachable', code: typeof code === 'string' && SAFE_CODE.test(code) ? code : 'UNKNOWN' })
    throw new AiProviderError('Could not reach the AI provider.')
  }
  // 'manual' gives a 3xx (or an opaque type 'opaqueredirect' with status 0 in browsers).
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    throw new AiProviderError('The AI provider redirected; the redirect was not followed.')
  }
  return res
}

/**
 * providerRequest + "2xx or throw". A non-2xx answer throws AiProviderError carrying the HTTP
 * status only: the provider's error body is neither returned, nor shown, nor logged (it can echo
 * keys, org names or prompts). The server log gets {status, reason}.
 */
export async function providerFetch(
  url: string,
  init: RequestInit,
  deps: { fetchImpl?: ProviderFetch; lookup?: Lookup; timeoutMs?: number } = {},
): Promise<Response> {
  const res = await providerRequest(url, init, deps)
  if (!res.ok) {
    console.error('AI provider error', { status: res.status, reason: 'http_error' })
    throw new AiProviderError(`The AI provider answered with an error (HTTP ${res.status}).`)
  }
  return res
}
