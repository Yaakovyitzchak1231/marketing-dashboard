/**
 * Listing an OpenAI-compatible provider's models (GET {base_url}/models with a
 * Bearer key) for the AI model dropdown on /settings. Server-side only in
 * practice (the key never reaches the browser), but these functions are pure
 * apart from the injected fetch, so they are unit-tested directly.
 */
import { AiProviderError, providerRequest, type Lookup, type ProviderFetch } from './ai-provider.ts'
import { validatePublicHttpsUrl } from './safe-url.ts'

export type ModelListResult = { ok: true; models: string[] } | { ok: false; message: string }

/**
 * Model ids from a /models response. Accepts the OpenAI shape
 * {data:[{id}]}, Ollama's native /api/tags shape {models:[{name}|{model}]},
 * and a bare array of ids or objects. Sorted, de-duplicated. Anything else → [].
 */
export function parseModelList(body: unknown): string[] {
  const pick = (x: unknown): string | null => {
    if (typeof x === 'string') return x.trim() || null
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>
      for (const k of ['id', 'name', 'model']) if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim()
    }
    return null
  }
  let list: unknown[] = []
  if (Array.isArray(body)) list = body
  else if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>
    if (Array.isArray(o.data)) list = o.data
    else if (Array.isArray(o.models)) list = o.models
  }
  const ids = list.map(pick).filter((s): s is string => Boolean(s))
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

/** {base}/models with exactly one slash, e.g. https://api.groq.com/openai/v1 → https://api.groq.com/openai/v1/models. */
export function modelsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/models`
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; cache?: 'no-store'; redirect?: 'manual' }) => Promise<{ ok: boolean; status: number; type?: string; json: () => Promise<unknown> }>
// (test seam: production uses the pinned transport in ai-provider.ts)

/** Fetch and parse the provider's model list. Never throws; never includes the key in the message. */
export async function fetchModelList(
  baseUrl: string | null,
  apiKey: string | null,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; lookup?: Lookup } = {},
): Promise<ModelListResult> {
  if (!baseUrl?.trim()) return { ok: false, message: 'Set the AI provider base URL first.' }
  let url: string
  try {
    url = modelsUrl(baseUrl)
    new URL(url)
  } catch {
    return { ok: false, message: 'The AI provider base URL is not a valid URL.' }
  }
  const bad = validatePublicHttpsUrl(url)
  if (bad) return { ok: false, message: `The AI provider base URL is not allowed: ${bad}` }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6000)
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (apiKey?.trim()) headers.authorization = `Bearer ${apiKey.trim()}`
    // The one guarded provider transport (lib/settings/ai-provider.ts): public host only, the
    // connection pinned to the checked IP, no redirects, status-only errors.
    const res = await providerRequest(url, { headers, signal: ctrl.signal, cache: 'no-store' }, {
      fetchImpl: opts.fetchImpl as unknown as ProviderFetch | undefined,
      lookup: opts.lookup,
      timeoutMs: opts.timeoutMs ?? 6000,
    })
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'The provider rejected the API key. Check the AI provider API key.' }
    if (!res.ok) return { ok: false, message: `The provider answered ${res.status} for its model list.` }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return { ok: false, message: 'The provider’s model list was not JSON.' }
    }
    const models = parseModelList(body)
    if (!models.length) return { ok: false, message: 'The provider returned no models.' }
    return { ok: true, models }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return { ok: false, message: 'The provider did not answer in time.' }
    if (e instanceof AiProviderError) return { ok: false, message: e.message }
    return { ok: false, message: 'Could not reach the provider.' }
  } finally {
    clearTimeout(timer)
  }
}
