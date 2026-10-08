/**
 * A "Find leads" job's parameters: validated once, used by the dashboard route
 * that creates the job and by the runner that works it. Pure (no Node APIs),
 * so the /find page and API routes import it too.
 */

export type EngineSegment = 'jeweler' | 'ai_agency'
export type EngineStage = 'discover' | 'crawl' | 'owner' | 'reviews' | 'yelp' | 'firstlast' | 'facebook' | 'pattern' | 'build'
/** Every stage, in the order a job runs them. */
export const ALL_STAGES: EngineStage[] = ['discover', 'crawl', 'owner', 'reviews', 'yelp', 'firstlast', 'facebook', 'pattern', 'build']
/** Extra owner-name / direct-email sources (engine/ownerStages.ts). Opt-in: off unless a job ticks them. */
export const OWNER_EXTRA_STAGES: EngineStage[] = ['reviews', 'yelp', 'firstlast', 'facebook', 'pattern']
/** What a job runs when it names no stages. */
export const ENGINE_STAGES: EngineStage[] = ['discover', 'crawl', 'owner', 'build']

/**
 * The measured best query set for jewelers (Oct 6, 2026: 7 queries x the
 * top-1000 US cities = 7,609 Maps searches -> 30,854 unique places -> 4,128 new
 * independent stores after filters and dedupe).
 */
export const JEWELER_QUERIES = ['jewelry store', 'diamond store', 'custom jeweler', 'goldsmith', 'fine jewelry', 'engagement rings', 'jewelry repair']
/** Not measured yet: a starting set for AI agencies / builders. */
export const AI_AGENCY_QUERIES = ['AI automation agency', 'AI agency', 'automation agency', 'chatbot development company', 'software development agency']

export interface FindLeadsParams {
  segment: EngineSegment
  queries: string[]
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

export function normalizeFindParams(raw: unknown): FindLeadsParams {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const segment: EngineSegment = o.segment === 'ai_agency' ? 'ai_agency' : 'jeweler'
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
  let queries = list(o.queries).slice(0, 20)
  if (!queries.length) queries = segment === 'jeweler' ? JEWELER_QUERIES : AI_AGENCY_QUERIES
  const max = Math.trunc(Number(o.max_businesses ?? o.max ?? 100))
  if (!Number.isFinite(max) || max < 1) throw new ParamsError('max businesses must be at least 1')
  const stagesIn = list(o.stages).filter((s): s is EngineStage => (ALL_STAGES as string[]).includes(s))
  const stages = stagesIn.length ? ALL_STAGES.filter((s) => stagesIn.includes(s)) : ENGINE_STAGES
  if (!stages.includes('discover')) throw new ParamsError('the discover stage is required')
  const conc = (o.concurrency && typeof o.concurrency === 'object' ? o.concurrency : {}) as Record<string, unknown>
  const clamp = (v: unknown, d: number, hi: number) => Math.min(hi, Math.max(1, Math.trunc(Number(v ?? d)) || d))
  return {
    segment,
    queries,
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
  const seg = p.segment === 'jeweler' ? 'jewelers' : 'AI agencies'
  return `Find ${p.max_businesses} ${seg} in ${describeGeography(p)}`.slice(0, 300)
}
