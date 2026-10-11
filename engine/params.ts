/**
 * A "Find leads" job's parameters: validated once, used by the dashboard route
 * that creates the job and by the runner that works it. Pure (no Node APIs),
 * so the /find page and API routes import it too.
 *
 * `segment` is any pool slug (campaign-agnostic — see lib/pools/store.ts),
 * not a fixed union. search_phrases / place_categories / negative_keywords
 * are the campaign's search config (engine/searchConfig.ts resolves it from
 * the campaign's approved profile items, falling back to the pool's built-in
 * default list, engine/data/default-search-configs.ts, ONLY when the
 * campaign has none); config_source says which one a run actually used
 * ("profile" or "built-in default for pool X"), logged on the run.
 */
import { DEFAULT_SEARCH_CONFIGS, JEWELER_QUERIES, AI_AGENCY_QUERIES, defaultSearchConfigFor, type SearchConfig } from './data/default-search-configs.ts'
import type { ResolvedSearchConfig } from './searchConfig.ts'

export { JEWELER_QUERIES, AI_AGENCY_QUERIES, DEFAULT_SEARCH_CONFIGS, defaultSearchConfigFor }
export type { SearchConfig }

export type EngineSegment = string
export type EngineStage = 'discover' | 'crawl' | 'owner' | 'reviews' | 'yelp' | 'firstlast' | 'facebook' | 'pattern' | 'build'
/** Every stage, in the order a job runs them. */
export const ALL_STAGES: EngineStage[] = ['discover', 'crawl', 'owner', 'reviews', 'yelp', 'firstlast', 'facebook', 'pattern', 'build']
/** Extra owner-name / direct-email sources (engine/ownerStages.ts). Opt-in: off unless a job ticks them. */
export const OWNER_EXTRA_STAGES: EngineStage[] = ['reviews', 'yelp', 'firstlast', 'facebook', 'pattern']
/** What a job runs when it names no stages. */
export const ENGINE_STAGES: EngineStage[] = ['discover', 'crawl', 'owner', 'build']

export interface FindLeadsParams {
  segment: EngineSegment
  /** The dashboard campaign this run was started for, when any. */
  campaign_id: number | null
  queries: string[]
  /** The campaign's approved search config, or the pool's built-in default (see above). */
  search_phrases: string[]
  place_categories: string[]
  negative_keywords: string[]
  /** "profile" or "built-in default for pool X" — which source search_phrases/place_categories/negative_keywords came from. */
  config_source: string
  geography: { states: string[]; cities: string[]; all_us: boolean }
  max_businesses: number
  stages: EngineStage[]
  proxies: boolean
  /** Discovery source: Google Maps endpoint, or a CSV/JSONL file on the runner's disk (Overture/OSM export, a list). */
  source: 'maps' | 'file'
  file_path: string | null
  concurrency: { maps: number; crawl: number }
}

export const MAX_BUSINESSES_CAP = 25_000

export class ParamsError extends Error {}

const STATE_RE = /^[A-Z]{2}$/
const POOL_RE = /^[a-z][a-z0-9_]{0,40}$/

export function normalizeFindParams(raw: unknown, resolved?: ResolvedSearchConfig): FindLeadsParams {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rawSegment = typeof o.segment === 'string' ? o.segment.trim().toLowerCase() : typeof o.pool === 'string' ? o.pool.trim().toLowerCase() : ''
  const segment: EngineSegment = POOL_RE.test(rawSegment) ? rawSegment : 'jeweler'
  const geo = (o.geography && typeof o.geography === 'object' ? o.geography : {}) as Record<string, unknown>
  const list = (v: unknown, sep: RegExp = /[,;\n]/): string[] =>
    (Array.isArray(v) ? v : typeof v === 'string' ? v.split(sep) : []).map((s) => String(s).trim()).filter(Boolean)
  const rawStates = list(geo.states ?? o.states)
  for (const s of rawStates) if (!STATE_RE.test(s.toUpperCase())) throw new ParamsError(`"${s}" is not a 2-letter state code (e.g. MD)`)
  const states = [...new Set(rawStates.map((s) => s.toUpperCase()))]
  const cities = list(geo.cities ?? o.cities, /[;\n]/) // "Towson, MD; Columbia, MD"
  for (const c of cities) if (!/^[^,]+,\s*[A-Za-z]{2}$/.test(c)) throw new ParamsError(`city "${c}" should look like "Towson, MD"`)
  const all_us = geo.all_us === true || o.all_us === true
  const source = o.source === 'file' ? 'file' : 'maps'
  const file_path = typeof o.file_path === 'string' && o.file_path.trim() ? o.file_path.trim() : null
  if (source === 'maps' && !all_us && !states.length && !cities.length) throw new ParamsError('pick at least one state or city, or all of the US')
  if (source === 'file' && !file_path) throw new ParamsError('a file source needs file_path')

  // Search config: an explicit `resolved` (from the DB, at job-create time, when
  // campaign_id was given) wins; re-normalizing an already-resolved stored job
  // payload (the runner does this) reuses what is already on it; otherwise this
  // is a manual/ad hoc run (no campaign) and falls back to the pool's built-in
  // default list.
  let search_phrases: string[]
  let place_categories: string[]
  let negative_keywords: string[]
  let config_source: string
  let campaign_id: number | null
  const rawCampaignId = Number(o.campaign_id)
  if (resolved) {
    search_phrases = resolved.config.search_phrases
    place_categories = resolved.config.place_categories
    negative_keywords = resolved.config.negative_keywords
    config_source = resolved.source
    campaign_id = resolved.campaign_id
  } else if (Array.isArray(o.search_phrases) || Array.isArray(o.place_categories) || Array.isArray(o.negative_keywords) || typeof o.config_source === 'string') {
    search_phrases = list(o.search_phrases)
    place_categories = list(o.place_categories)
    negative_keywords = list(o.negative_keywords)
    config_source = typeof o.config_source === 'string' ? o.config_source : 'unknown'
    campaign_id = Number.isInteger(rawCampaignId) && rawCampaignId > 0 ? rawCampaignId : null
  } else {
    const def = defaultSearchConfigFor(segment) ?? { search_phrases: [], place_categories: [], negative_keywords: [] }
    search_phrases = def.search_phrases
    place_categories = def.place_categories
    negative_keywords = def.negative_keywords
    config_source = `built-in default for pool ${segment}`
    campaign_id = Number.isInteger(rawCampaignId) && rawCampaignId > 0 ? rawCampaignId : null
  }

  let queries = list(o.queries).slice(0, 20)
  if (!queries.length) queries = search_phrases.length ? search_phrases : segment === 'jeweler' ? JEWELER_QUERIES : segment === 'ai_agency' ? AI_AGENCY_QUERIES : []
  if (!queries.length) throw new ParamsError('no searches: give queries, or set the campaign\'s approved search phrases first')
  const max = Math.trunc(Number(o.max_businesses ?? o.max ?? 100))
  if (!Number.isFinite(max) || max < 1) throw new ParamsError('max businesses must be at least 1')
  const stagesIn = list(o.stages).filter((s): s is EngineStage => (ALL_STAGES as string[]).includes(s))
  const stages = stagesIn.length ? ALL_STAGES.filter((s) => stagesIn.includes(s)) : ENGINE_STAGES
  if (!stages.includes('discover')) throw new ParamsError('the discover stage is required')
  const conc = (o.concurrency && typeof o.concurrency === 'object' ? o.concurrency : {}) as Record<string, unknown>
  const clamp = (v: unknown, d: number, hi: number) => Math.min(hi, Math.max(1, Math.trunc(Number(v ?? d)) || d))
  return {
    segment,
    campaign_id,
    queries,
    search_phrases,
    place_categories,
    negative_keywords,
    config_source,
    geography: { states, cities, all_us },
    max_businesses: Math.min(max, MAX_BUSINESSES_CAP),
    stages,
    proxies: o.proxies === true,
    source,
    file_path,
    // Measured: Maps at 6 concurrent = 0 blocks; store sites at 40 got Shopify 429s, so 8 by default.
    concurrency: { maps: clamp(conc.maps, 6, 12), crawl: clamp(conc.crawl, 8, 32) },
  }
}

export function describeGeography(p: FindLeadsParams): string {
  if (p.source === 'file') return 'a file list'
  if (p.geography.all_us) return 'all of the US'
  return [...p.geography.states, ...p.geography.cities].join(', ')
}

export function findJobTitle(p: FindLeadsParams): string {
  const seg = p.segment === 'jeweler' ? 'jewelers' : p.segment === 'ai_agency' ? 'AI agencies' : p.segment.replace(/_/g, ' ')
  return `Find ${p.max_businesses} ${seg} in ${describeGeography(p)}`.slice(0, 300)
}
