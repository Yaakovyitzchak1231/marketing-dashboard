/**
 * AI-assisted campaign setup. Type an industry (plus optional ICP notes and
 * example customer websites) and get suggested keywords, topics, competitors,
 * feeds, forums, directories, trade shows, signal rules, fingerprints and
 * negative keywords, plus a suggested ICP/UTM/KPIs — each item with a
 * one-line rationale. Nothing is auto-approved: everything is saved as
 * campaign_profile_items with status 'suggested', source 'ai', and a human
 * approves/rejects it afterward (lib/campaign-profiles/store.ts addItems).
 *
 * Provider: free/OSS only, any OpenAI-compatible chat completions endpoint
 * (a local Ollama on Yaakov's OVH server, Groq's free tier, OpenRouter's free
 * models, ...). Config comes from env for now (AI_BASE_URL, AI_API_KEY,
 * AI_MODEL) behind one getAiConfig() — TODO: once lib/settings exists (a
 * parallel PR), read AI provider config from there first, env as a fallback,
 * the same way lib/settings/registry.ts's resolveConfig() will do for other
 * keys.
 */
import 'server-only'
import type { Db } from '../db/types.ts'
import { ProfileError, addItems, type ItemInput, type ItemKind, upsertProfile } from './store.ts'
import { verifyItemsAndSave } from './verify.ts'

export interface AiConfig {
  baseUrl: string
  apiKey: string | null
  model: string
}

/**
 * Reads AI_BASE_URL / AI_API_KEY / AI_MODEL from the environment.
 * TODO(settings): switch to lib/settings's resolveConfig() once that PR lands
 * (DB first, then env) — this function is the one seam that call will replace.
 */
export function getAiConfig(): AiConfig | null {
  const baseUrl = process.env.AI_BASE_URL?.trim()
  const model = process.env.AI_MODEL?.trim()
  if (!baseUrl || !model) return null
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: process.env.AI_API_KEY?.trim() || null, model }
}

export interface SuggestInput {
  campaign_id: number
  industry: string
  notes?: string | null
  example_sites?: string[]
}

export interface SuggestedItem {
  kind: ItemKind
  name: string
  value?: string | null
  config?: Record<string, unknown>
  rationale: string
}

export interface SuggestedProfile {
  industry?: string
  vertical?: string | null
  description?: string | null
  icp?: Record<string, unknown>
  value_prop?: string | null
  utm?: Record<string, unknown>
  kpis?: { metric: string; target: number; period: string }[]
}

export interface SuggestResult {
  configured: true
  model: string
  items_saved: number
  items_dropped: number
  dropped_reasons: string[]
  by_kind: Record<string, number>
  profile: SuggestedProfile | null
  verified_ok: number
  verified_failed: number
  not_applicable: number
}

export type SuggestOutcome = SuggestResult | { configured: false; reason: string }

const ITEM_KINDS_LIST = ['keyword', 'topic', 'competitor', 'feed', 'forum', 'directory', 'trade_show', 'signal_rule', 'fingerprint', 'social_channel', 'negative_keyword', 'search_phrase', 'place_category']

const SYSTEM_PROMPT = `You help set up a B2B marketing/prospecting campaign profile for ANY industry the user names \
(do not assume jewelry, payments or AI agencies unless the user's industry says so). Given an industry, optional \
ICP notes and optional example customer websites, suggest concrete, real, verifiable setup items: search keywords \
and topics, named competitors (with their real domains), real RSS/news feed URLs, real subreddits or forums, real \
lead-source directories or trade associations, real trade shows, buying-signal rules, website tech fingerprints to \
detect, negative keywords, search phrases a find-leads engine should run (maps/web search queries like "independent \
jeweler"), business categories for map/directory searches, plus a suggested ICP, a suggested UTM convention and 2-4 KPIs.

Reply with ONLY a single JSON object (no prose, no markdown fences), shaped exactly like this:
{
  "industry": "string",
  "vertical": "string or null",
  "description": "one paragraph or null",
  "icp": {"business_types": ["..."], "size": {"employees_min": null, "employees_max": null, "revenue_min": null, "revenue_max": null}, "geographies": ["..."], "roles": ["..."], "exclude": ["..."]},
  "value_prop": "string or null",
  "utm": {"source": "string", "medium": "string", "campaign": "string", "content_rule": "string or null"},
  "kpis": [{"metric": "string", "target": 0, "period": "string"}],
  "items": [
    {"kind": "keyword|topic|competitor|feed|forum|directory|trade_show|signal_rule|fingerprint|social_channel|negative_keyword|search_phrase|place_category",
     "name": "string", "value": "string or null", "config": {}, "rationale": "one line, why this helps"}
  ]
}
For "competitor" items, name = the company name and config may carry newsroom_url/changelog_url/pricing_url/ads_library_url \
(real http(s) URLs only, or omit the field). For "feed" items, value must be a real http(s) RSS/Atom or news-search URL. \
For "signal_rule" items, config.type must be one of tech_change, hiring, filing, page_change, review, funding, new_location, custom. \
For "fingerprint" items, config.patterns must be a non-empty array of strings. Give at least 2 items per kind where the \
industry supports it. Never invent a competitor, feed or directory that does not exist — if unsure, omit it rather than \
make one up.`

function buildUserPrompt(input: SuggestInput): string {
  const lines = [`Industry: ${input.industry}`]
  if (input.notes) lines.push(`ICP notes: ${input.notes}`)
  if (input.example_sites?.length) lines.push(`Example customer websites: ${input.example_sites.join(', ')}`)
  return lines.join('\n')
}

/** Strip ```json fences and leading/trailing prose around a JSON object, defensively. */
export function extractJson(raw: string): unknown {
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first === -1 || last === -1 || last < first) throw new ProfileError('The AI reply had no JSON object in it.')
  const slice = s.slice(first, last + 1)
  try {
    return JSON.parse(slice)
  } catch (e) {
    throw new ProfileError(`The AI reply was not valid JSON (${e instanceof Error ? e.message : 'parse error'}).`)
  }
}

interface ValidatedSuggestions {
  profile: SuggestedProfile
  items: SuggestedItem[]
  dropped: string[]
}

/** Validate every suggested item; drop (don't throw on) anything malformed, and say why. */
export function validateSuggestions(parsed: unknown): ValidatedSuggestions {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ProfileError('The AI reply must be a JSON object.')
  const b = parsed as Record<string, unknown>
  const profile: SuggestedProfile = {}
  if (typeof b.industry === 'string' && b.industry.trim()) profile.industry = b.industry.trim().slice(0, 120)
  if (typeof b.vertical === 'string' && b.vertical.trim()) profile.vertical = b.vertical.trim().slice(0, 120)
  if (typeof b.description === 'string' && b.description.trim()) profile.description = b.description.trim().slice(0, 4000)
  if (b.icp && typeof b.icp === 'object' && !Array.isArray(b.icp)) profile.icp = b.icp as Record<string, unknown>
  if (typeof b.value_prop === 'string' && b.value_prop.trim()) profile.value_prop = b.value_prop.trim().slice(0, 2000)
  if (b.utm && typeof b.utm === 'object' && !Array.isArray(b.utm)) profile.utm = b.utm as Record<string, unknown>
  if (Array.isArray(b.kpis)) {
    const kpis: { metric: string; target: number; period: string }[] = []
    for (const k of b.kpis) {
      if (!k || typeof k !== 'object') continue
      const kb = k as Record<string, unknown>
      const metric = typeof kb.metric === 'string' ? kb.metric.trim() : ''
      const target = Number(kb.target)
      const period = typeof kb.period === 'string' ? kb.period.trim() : ''
      if (metric && Number.isFinite(target) && period) kpis.push({ metric, target, period })
    }
    if (kpis.length) profile.kpis = kpis
  }

  const items: SuggestedItem[] = []
  const dropped: string[] = []
  const rawItems = Array.isArray(b.items) ? b.items : []
  for (let i = 0; i < rawItems.length; i++) {
    const it = rawItems[i]
    if (!it || typeof it !== 'object' || Array.isArray(it)) { dropped.push(`items[${i}]: not an object`); continue }
    const ib = it as Record<string, unknown>
    if (typeof ib.kind !== 'string' || !ITEM_KINDS_LIST.includes(ib.kind)) { dropped.push(`items[${i}]: unknown kind "${String(ib.kind)}"`); continue }
    const kind = ib.kind as ItemKind
    const name = typeof ib.name === 'string' ? ib.name.trim().slice(0, 200) : ''
    if (!name) { dropped.push(`items[${i}] (${kind}): missing name`); continue }
    const rationale = typeof ib.rationale === 'string' && ib.rationale.trim() ? ib.rationale.trim().slice(0, 1000) : 'suggested by AI'
    const value: string | null = typeof ib.value === 'string' && ib.value.trim() ? ib.value.trim().slice(0, 2000) : null
    let config: Record<string, unknown> = ib.config && typeof ib.config === 'object' && !Array.isArray(ib.config) ? (ib.config as Record<string, unknown>) : {}

    // Per-kind checks, mirroring lib/campaign-profiles/store.ts's checkItem — drop rather than throw.
    if (kind === 'feed') {
      if (!value || !/^https?:\/\//i.test(value)) { dropped.push(`items[${i}] (feed "${name}"): value is not an http(s) URL`); continue }
      config = { ...config, unverified: true }
    }
    if (kind === 'competitor') {
      const urlFields = ['newsroom_url', 'changelog_url', 'pricing_url', 'ads_library_url'] as const
      let bad = false
      for (const f of urlFields) {
        const u = config[f]
        if (u !== undefined && u !== null && u !== '' && !(typeof u === 'string' && /^https?:\/\//i.test(u))) { bad = true }
      }
      if (bad) { dropped.push(`items[${i}] (competitor "${name}"): a config URL is not http(s)`); continue }
    }
    if (kind === 'signal_rule') {
      const t = config.type
      const types = ['tech_change', 'hiring', 'filing', 'page_change', 'review', 'funding', 'new_location', 'custom']
      if (typeof t !== 'string' || !types.includes(t)) { dropped.push(`items[${i}] (signal_rule "${name}"): bad config.type`); continue }
    }
    if (kind === 'fingerprint') {
      const p = config.patterns
      if (!Array.isArray(p) || !p.length || !p.every((x) => typeof x === 'string' && x.trim())) { dropped.push(`items[${i}] (fingerprint "${name}"): config.patterns must be a non-empty string list`); continue }
    }
    items.push({ kind, name, value, config, rationale })
  }
  return { profile, items, dropped }
}

async function callChat(cfg: AiConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new ProfileError(`The AI provider answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new ProfileError('The AI provider returned no message content.')
    return content
  } catch (e) {
    if (e instanceof ProfileError) throw e
    if (e instanceof Error && e.name === 'AbortError') throw new ProfileError('The AI provider did not answer within 60s.')
    throw new ProfileError(`Could not reach the AI provider: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Suggest a campaign setup with AI, and save everything as 'suggested' items
 * (source 'ai') — never auto-approved. When no AI provider is configured,
 * returns {configured:false} so the UI can say "AI suggestions need an AI
 * provider — add one in Settings" while manual entry still works.
 */
export async function suggestCampaignProfile(db: Db, actor: string, input: SuggestInput, deps: { chat?: typeof callChat; verify?: { fetchImpl?: typeof fetch } } = {}): Promise<SuggestOutcome> {
  const campaignId = Number(input.campaign_id)
  if (!Number.isInteger(campaignId) || campaignId <= 0) throw new ProfileError('campaign_id must be a positive integer.')
  const industry = typeof input.industry === 'string' ? input.industry.trim() : ''
  if (!industry) throw new ProfileError('industry is required.')
  const cfg = getAiConfig()
  if (!cfg) return { configured: false, reason: 'no AI provider is configured (AI_BASE_URL / AI_MODEL)' }

  const chat = deps.chat ?? callChat
  const content = await chat(cfg, SYSTEM_PROMPT, buildUserPrompt({ campaign_id: campaignId, industry, notes: input.notes, example_sites: input.example_sites }))
  const parsed = extractJson(content)
  const { profile, items, dropped } = validateSuggestions(parsed)

  const byKind: Record<string, number> = {}
  let saved = 0
  let verifiedOk = 0
  let verifiedFailed = 0
  let notApplicable = 0
  if (items.length) {
    const toSave: (ItemInput & { status: 'suggested'; source: 'ai' })[] = items.map((it) => ({
      kind: it.kind, name: it.name, value: it.value ?? null, config: it.config ?? {}, rationale: it.rationale, status: 'suggested', source: 'ai',
    }))
    const r = await addItems(db, actor, campaignId, toSave, 'ops_api')
    saved = r.added.length
    for (const a of r.added) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1
    // Verify every suggestion before Yaakov sees it (a feed parses and has recent items, a
    // page loads and robots.txt allows it, a subreddit exists) — concurrency-limited, with an
    // overall time budget so one slow site never holds up the whole suggestion.
    if (r.added.length) {
      const results = await verifyItemsAndSave(
        db,
        actor,
        r.added.map((a) => ({ id: a.id, kind: a.kind, name: a.name, value: a.value, config: a.config })),
        { ...(deps.verify ?? {}), concurrency: 5, budgetMs: 30_000 },
      )
      for (const v of results) {
        if (v.status === 'ok') verifiedOk += 1
        else if (v.status === 'failed') verifiedFailed += 1
        else if (v.status === 'not_applicable') notApplicable += 1
      }
    }
  }

  const profilePatch: Record<string, unknown> = { setup_status: 'suggested' }
  if (profile.industry) profilePatch.industry = profile.industry
  else profilePatch.industry = industry
  if (profile.vertical !== undefined) profilePatch.vertical = profile.vertical
  if (profile.description !== undefined) profilePatch.description = profile.description
  if (profile.icp !== undefined) profilePatch.icp = profile.icp
  if (profile.value_prop !== undefined) profilePatch.value_prop = profile.value_prop
  if (profile.utm !== undefined) profilePatch.utm = profile.utm
  if (profile.kpis !== undefined) profilePatch.kpis = profile.kpis
  await upsertProfile(db, actor, campaignId, profilePatch)
  await db.tx(async (q) => {
    await q.query(`update lp.campaign_profiles set ai_last_suggested_at = now(), ai_model = $2, updated_by = $3 where campaign_id = $1`, [campaignId, cfg.model, actor])
  }, actor)

  return {
    configured: true,
    model: cfg.model,
    items_saved: saved,
    items_dropped: dropped.length,
    dropped_reasons: dropped,
    by_kind: byKind,
    profile,
    verified_ok: verifiedOk,
    verified_failed: verifiedFailed,
    not_applicable: notApplicable,
  }
}

export interface VerifyFeedResult {
  ok: boolean
  reason?: string
}

/**
 * Fetch a feed URL (8s timeout) and check it at least looks like RSS/Atom.
 * The UI can call this per suggested feed to clear its "unverified" mark.
 * fetchImpl is injectable so tests can mock it.
 */
export async function verifyFeed(url: string, fetchImpl: typeof fetch = fetch): Promise<VerifyFeedResult> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'not an http(s) URL' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    const text = await res.text()
    const looksLikeFeed = /<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(text.slice(0, 4000))
    if (!looksLikeFeed) return { ok: false, reason: 'response does not parse as RSS/Atom' }
    return { ok: true }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return { ok: false, reason: 'timed out after 8s' }
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}
