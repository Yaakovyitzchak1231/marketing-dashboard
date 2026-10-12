/**
 * The one guarded path to the configured AI provider (ai.base_url / AI_BASE_URL).
 * Every provider fetch — campaign-profile suggestions, segment "Describe it",
 * the /settings model list — goes through providerFetch():
 *  - the base URL must pass validatePublicHttpsUrl (DB value or env fallback alike);
 *  - the host is resolved right before the fetch and refused if any address is private;
 *  - redirects are never followed (a 3xx could point at a private host);
 *  - error bodies are never shown: callers get the HTTP status, the body goes to
 *    console.error (truncated, never the key).
 */
import { resolveConfig } from './store.ts'
import { assertPublicHost, validatePublicHttpsUrl } from './safe-url.ts'

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
  if (!baseUrl || !model) return { cfg: null, reason: 'no AI provider is configured (AI_BASE_URL / AI_MODEL)' }
  const bad = validatePublicHttpsUrl(baseUrl)
  if (bad) return { cfg: null, reason: `the AI provider base URL is not allowed: ${bad}` }
  return { cfg: { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: k.value?.trim() || null, model } }
}

export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * Fetch a provider URL with the SSRF guard, no redirects. Throws AiProviderError with a
 * person-safe message for: a disallowed URL, a private DNS answer, a redirect, a
 * non-2xx answer (status only), or no answer. Returns the 2xx Response.
 */
export async function providerFetch(
  url: string,
  init: RequestInit,
  deps: { fetchImpl?: ProviderFetch; lookup?: Lookup } = {},
): Promise<Response> {
  if (validatePublicHttpsUrl(url)) throw new AiProviderError('The AI provider base URL is not allowed.')
  try {
    await assertPublicHost(url, deps.lookup)
  } catch (e) {
    throw new AiProviderError((e as Error).message)
  }
  const fetchImpl = deps.fetchImpl ?? (fetch as ProviderFetch)
  let res: Response
  try {
    res = await fetchImpl(url, { ...init, redirect: 'manual' })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e
    console.error('AI provider unreachable', e instanceof Error ? e.message : String(e))
    throw new AiProviderError('Could not reach the AI provider.')
  }
  // 'manual' gives a 3xx (or an opaque type 'opaqueredirect' with status 0 in browsers).
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    throw new AiProviderError('The AI provider redirected; the redirect was not followed.')
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error('AI provider error', res.status, body.slice(0, 300))
    throw new AiProviderError(`The AI provider answered with an error (HTTP ${res.status}).`, )
  }
  return res
}
