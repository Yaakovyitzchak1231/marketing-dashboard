/**
 * AI answer visibility: ask each model the questions buyers ask, and record
 * whether TapDash is named, which competitors are, and which sites are cited.
 * A provider runs only when its key is set; nothing here has a default key,
 * and nothing runs on a timer unless someone schedules it.
 */

export type ProviderId = 'gemini' | 'openai' | 'anthropic' | 'perplexity'

export interface ProviderInfo {
  id: ProviderId
  label: string
  env: string
  modelEnv: string
  defaultModel: string
  cost: string
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'gemini', label: 'Gemini', env: 'GEMINI_API_KEY', modelEnv: 'SEO_GEMINI_MODEL', defaultModel: 'gemini-2.5-flash', cost: 'Free tier (rate-limited). Grounded in Google Search only on a billing-enabled project; first 5,000 grounded requests a month free.' },
  { id: 'openai', label: 'ChatGPT (OpenAI API)', env: 'OPENAI_API_KEY', modelEnv: 'SEO_OPENAI_MODEL', defaultModel: 'gpt-4o-mini', cost: 'No free tier. A 20-question weekly run is cents a month; with web search on, roughly $1-2 a month.' },
  { id: 'anthropic', label: 'Claude (Anthropic API)', env: 'ANTHROPIC_API_KEY', modelEnv: 'SEO_ANTHROPIC_MODEL', defaultModel: 'claude-haiku-4-5', cost: 'No free tier. Cents a month for a weekly run; web search adds about a cent per question.' },
  { id: 'perplexity', label: 'Perplexity (API)', env: 'PERPLEXITY_API_KEY', modelEnv: 'SEO_PERPLEXITY_MODEL', defaultModel: 'sonar', cost: 'Paid per request (always searches the web). Optional.' },
]

export function providerKey(p: ProviderInfo, env: Record<string, string | undefined> = process.env): string | null {
  const v = env[p.env]?.trim()
  return v ? v : null
}
export function providerModel(p: ProviderInfo, env: Record<string, string | undefined> = process.env): string {
  return env[p.modelEnv]?.trim() || p.defaultModel
}
/** SEO_WEB_SEARCH=1 turns on live web search where the provider supports it (closer to what people see; may cost more). */
export function webSearchOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.SEO_WEB_SEARCH === '1'
}

export interface Answer {
  text: string
  citedUrls: string[]
}

export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number
  text(): Promise<string>
}>

async function postJson(fetcher: HttpFetch, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const r = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) })
  const text = await r.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not json */
  }
  if (r.status < 200 || r.status >= 300) {
    const err = json as { error?: { message?: string } | string } | null
    const msg = typeof err?.error === 'string' ? err.error : err?.error?.message
    throw new Error(`HTTP ${r.status}${msg ? `: ${msg.slice(0, 200)}` : ''}`)
  }
  return json
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]

export async function ask(provider: ProviderId, key: string, model: string, prompt: string, opts: { fetcher?: HttpFetch; webSearch?: boolean } = {}): Promise<Answer> {
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as HttpFetch)
  const web = !!opts.webSearch
  switch (provider) {
    case 'gemini': {
      const j = (await postJson(
        fetcher,
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': key },
        { contents: [{ role: 'user', parts: [{ text: prompt }] }], ...(web ? { tools: [{ google_search: {} }] } : {}) },
      )) as { candidates?: { content?: { parts?: { text?: string }[] }; groundingMetadata?: { groundingChunks?: { web?: { uri?: string } }[] } }[] }
      const c = j.candidates?.[0]
      return {
        text: (c?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
        citedUrls: uniq((c?.groundingMetadata?.groundingChunks ?? []).map((g) => g.web?.uri ?? '')),
      }
    }
    case 'openai': {
      const j = (await postJson(fetcher, 'https://api.openai.com/v1/responses', { Authorization: `Bearer ${key}` }, {
        model,
        input: prompt,
        ...(web ? { tools: [{ type: 'web_search' }] } : {}),
      })) as { output?: { type?: string; content?: { type?: string; text?: string; annotations?: { type?: string; url?: string }[] }[] }[] }
      const parts = (j.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text')
      return {
        text: parts.map((p) => p.text ?? '').join(''),
        citedUrls: uniq(parts.flatMap((p) => (p.annotations ?? []).filter((a) => a.type === 'url_citation').map((a) => a.url ?? ''))),
      }
    }
    case 'anthropic': {
      const j = (await postJson(fetcher, 'https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, {
        model,
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
        ...(web ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] } : {}),
      })) as { content?: { type?: string; text?: string; citations?: { url?: string }[] }[] }
      const blocks = (j.content ?? []).filter((b) => b.type === 'text')
      return { text: blocks.map((b) => b.text ?? '').join(''), citedUrls: uniq(blocks.flatMap((b) => (b.citations ?? []).map((c) => c.url ?? ''))) }
    }
    case 'perplexity': {
      const j = (await postJson(fetcher, 'https://api.perplexity.ai/chat/completions', { Authorization: `Bearer ${key}` }, {
        model,
        messages: [{ role: 'user', content: prompt }],
      })) as { choices?: { message?: { content?: string } }[]; citations?: string[]; search_results?: { url?: string }[] }
      return {
        text: j.choices?.[0]?.message?.content ?? '',
        citedUrls: uniq([...(j.citations ?? []), ...(j.search_results ?? []).map((s) => s.url ?? '')]),
      }
    }
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function contains(text: string, term: string): boolean {
  const t = term.trim()
  if (!t) return false
  return new RegExp(`(^|[^a-z0-9])${esc(t.toLowerCase())}([^a-z0-9]|$)`).test(text.toLowerCase())
}
function hostOf(u: string): string {
  try {
    return new URL(u).host.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

export interface Analysis {
  mentioned: boolean
  matchedTerms: string[]
  competitors: string[]
}

export function analyzeAnswer(answer: Answer, brandTerms: string[], competitors: { name: string; domain: string | null }[]): Analysis {
  const hosts = answer.citedUrls.map(hostOf)
  const matched = uniq(
    brandTerms.filter((t) => contains(answer.text, t) || hosts.some((h) => t.includes('.') && (h === t.toLowerCase().replace(/^www\./, '') || h.endsWith(`.${t.toLowerCase()}`)))),
  )
  const comp = competitors
    .filter((c) => contains(answer.text, c.name) || (c.domain ? hosts.some((h) => h === c.domain || h.endsWith(`.${c.domain}`)) : false))
    .map((c) => c.name)
  return { mentioned: matched.length > 0, matchedTerms: matched, competitors: uniq(comp) }
}
