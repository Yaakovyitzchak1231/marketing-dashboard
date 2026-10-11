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
}

// No cost field: we do not have a named source for what any of these cost, and
// an unsourced dollar figure on the page is a guess, not a measurement.
export const PROVIDERS: ProviderInfo[] = [
  { id: 'gemini', label: 'Gemini', env: 'GEMINI_API_KEY', modelEnv: 'SEO_GEMINI_MODEL', defaultModel: 'gemini-2.5-flash' },
  { id: 'openai', label: 'ChatGPT (OpenAI API)', env: 'OPENAI_API_KEY', modelEnv: 'SEO_OPENAI_MODEL', defaultModel: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Claude (Anthropic API)', env: 'ANTHROPIC_API_KEY', modelEnv: 'SEO_ANTHROPIC_MODEL', defaultModel: 'claude-haiku-4-5' },
  { id: 'perplexity', label: 'Perplexity (API)', env: 'PERPLEXITY_API_KEY', modelEnv: 'SEO_PERPLEXITY_MODEL', defaultModel: 'sonar' },
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
  /** Explicit provider refusal/safety stop, even if explanatory text was returned. */
  unanswered?: boolean
  text: string
  /** Only URLs explicitly attached to an answer by provider citation metadata. */
  citedUrls: string[]
  /** Retrieved/search sources are not necessarily cited in the answer. */
  retrievedUrls?: string[]
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

/** Only navigable HTTP(S) evidence links, never executable schemes or embedded credentials. */
export function safeSourceUrl(value: string): string | null {
  try {
    const u = new URL(value)
    return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null
  } catch { return null }
}
export const sourceUrls = (values: string[]) => uniq(values.map(safeSourceUrl).filter((u): u is string => u !== null))

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
      )) as { promptFeedback?: { blockReason?: string }; candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] }; groundingMetadata?: { groundingChunks?: { web?: { uri?: string } }[]; groundingSupports?: { groundingChunkIndices?: number[] }[] } }[] }
      const c = j.candidates?.[0]
      const blocked = !!j.promptFeedback?.blockReason || ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(c?.finishReason ?? '')
      const chunks = c?.groundingMetadata?.groundingChunks ?? []
      const cited = (c?.groundingMetadata?.groundingSupports ?? []).flatMap((s) => s.groundingChunkIndices ?? [])
      return {
        ...(blocked ? { unanswered: true } : {}),
        text: (c?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
        citedUrls: sourceUrls(cited.filter(Number.isInteger).map((i) => chunks[i]?.web?.uri ?? '')),
        retrievedUrls: sourceUrls(chunks.map((g) => g.web?.uri ?? '')),
      }
    }
    case 'openai': {
      const j = (await postJson(fetcher, 'https://api.openai.com/v1/responses', { Authorization: `Bearer ${key}` }, {
        model,
        input: prompt,
        ...(web ? { tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'] } : {}),
      })) as { output?: { type?: string; action?: { sources?: { url?: string }[] }; content?: { type?: string; text?: string; annotations?: { type?: string; url?: string }[] }[] }[] }
      const content = (j.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? [])
      const parts = content.filter((c) => c.type === 'output_text')
      return {
        ...(content.some((c) => c.type === 'refusal') ? { unanswered: true } : {}),
        text: parts.map((p) => p.text ?? '').join(''),
        citedUrls: sourceUrls(parts.flatMap((p) => (p.annotations ?? []).filter((a) => a.type === 'url_citation').map((a) => a.url ?? ''))),
        retrievedUrls: sourceUrls((j.output ?? []).filter((o) => o.type === 'web_search_call').flatMap((o) => o.action?.sources ?? []).map((s) => s.url ?? '')),
      }
    }
    case 'anthropic': {
      const j = (await postJson(fetcher, 'https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, {
        model,
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
        ...(web ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] } : {}),
      })) as { stop_reason?: string; content?: { type?: string; text?: string; citations?: { url?: string }[]; content?: { type?: string; url?: string }[] | { type?: string } }[] }
      const blocks = (j.content ?? []).filter((b) => b.type === 'text')
      return {
        ...(j.stop_reason === 'refusal' ? { unanswered: true } : {}),
        text: blocks.map((b) => b.text ?? '').join(''),
        citedUrls: sourceUrls(blocks.flatMap((b) => (b.citations ?? []).map((c) => c.url ?? ''))),
        retrievedUrls: sourceUrls((j.content ?? []).filter((b) => b.type === 'web_search_tool_result').flatMap((b) => Array.isArray(b.content) ? b.content : []).map((s) => s.url ?? '')),
      }
    }
    case 'perplexity': {
      const j = (await postJson(fetcher, 'https://api.perplexity.ai/chat/completions', { Authorization: `Bearer ${key}` }, {
        model,
        messages: [{ role: 'user', content: prompt }],
      })) as { choices?: { message?: { content?: string } }[]; citations?: string[]; search_results?: { url?: string }[] }
      return {
        text: j.choices?.[0]?.message?.content ?? '',
        citedUrls: sourceUrls(j.citations ?? []),
        retrievedUrls: sourceUrls((j.search_results ?? []).map((s) => s.url ?? '')),
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

export interface Analysis {
  mentioned: boolean
  matchedTerms: string[]
  competitors: string[]
}

export interface VisTally {
  attempted: number
  answered: number
  failed: number
  unknown: number
}

/**
 * Count what actually happened across a run's results. A result is answered
 * only when it carries a verdict (`mentioned` set); a provider error is a
 * failure; a response with no verdict and no error (empty or blocked) is
 * unknown and is never folded into the "not named" negatives.
 */
export function tallyResults(results: { mentioned: boolean | null; error: string | null }[]): VisTally {
  let answered = 0
  let failed = 0
  let unknown = 0
  for (const r of results) {
    if (r.error !== null) failed++
    else if (r.mentioned === null) unknown++
    else answered++
  }
  return { attempted: results.length, answered, failed, unknown }
}

/** The same measured denominator/caveats on overview, details and action feedback. */
export function visibilitySummary(run: {
  status: string; mentioned: number | null; answered: number | null; failed: number | null; unknown: number | null; measurement_version?: number | null
}, results?: { mentioned: boolean | null; error: string | null }[]): string {
  if (run.status === 'running') return 'in progress'
  const fallback = results?.length ? tallyResults(results) : null
  const answered = run.answered ?? fallback?.answered
  const failed = run.failed ?? fallback?.failed
  const unknown = run.unknown ?? fallback?.unknown
  if (answered == null) return 'answer counts unavailable'
  const details = `${unknown ? ` · ${unknown} unanswered` : ''}${failed ? ` · ${failed} error${failed === 1 ? '' : 's'}` : ''}`
  if (!answered) return `no readable answers${details}`
  if (run.mentioned == null) return `${answered} answered; mention count unavailable${details}`
  return run.measurement_version === 2
    ? `named in ${run.mentioned} of ${answered} answers${details}`
    : `matched in ${run.mentioned} of ${answered} answers (legacy text/source signal)${details}`
}

export function analyzeAnswer(answer: Answer, brandTerms: string[], competitors: { name: string; domain: string | null }[]): Analysis {
  // Naming a brand in prose and citing its site are different observations.
  const matched = uniq(brandTerms.filter((t) => contains(answer.text, t)))
  const comp = competitors
    .filter((c) => contains(answer.text, c.name) || (c.domain ? contains(answer.text, c.domain) : false))
    .map((c) => c.name)
  return { mentioned: matched.length > 0, matchedTerms: matched, competitors: uniq(comp) }
}
