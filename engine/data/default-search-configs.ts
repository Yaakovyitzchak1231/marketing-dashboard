/**
 * Legacy default search configs, kept ONLY as a fallback for the two pools
 * this app shipped with (jeweler, ai_agency) when a campaign has no approved
 * campaign-profile items yet. Every new pool / campaign gets its search
 * config from the campaign's own profile (lp.campaign_profile_items, kinds
 * search_phrase / place_category / negative_keyword) — see
 * engine/searchConfig.ts. Nothing here is read for a campaign that has
 * approved profile items; it is the "built-in default for pool X" path, and
 * every run logs which source it actually used.
 */

export interface SearchConfig {
  search_phrases: string[]
  place_categories: string[]
  negative_keywords: string[]
}

/**
 * The measured best query set for jewelers (Oct 6, 2026: 7 queries x the
 * top-1000 US cities = 7,609 Maps searches -> 30,854 unique places -> 4,128
 * new independent stores after filters and dedupe).
 */
export const JEWELER_QUERIES = ['jewelry store', 'diamond store', 'custom jeweler', 'goldsmith', 'fine jewelry', 'engagement rings', 'jewelry repair']
/** Not measured yet: a starting set for AI agencies / builders. */
export const AI_AGENCY_QUERIES = ['AI automation agency', 'AI agency', 'automation agency', 'chatbot development company', 'software development agency']

const JEWELER_CATEGORIES = [
  'Jewelry store', 'Jeweler', 'Jewelry designer', 'Jewelry repair service', 'Goldsmith', 'Diamond dealer', 'Jewelry appraiser',
  'Jewelry manufacturer', 'Wholesale jeweler', 'Silversmith', 'Watch store', 'Watch repair service', 'Gold dealer', 'Jewelry engraver',
  'Watch manufacturer', 'Gemologist', 'Jewellery store', 'Goldsmith shop',
]
const AI_AGENCY_CATEGORIES = ['Software company', 'Internet marketing service', 'Marketing agency', 'Web designer', 'Consultant', 'Advertising agency', 'Computer consultant']
const JEWELER_NEGATIVE_KEYWORDS = ['pawn', 'kay jewelers', 'zales', 'jared', 'helzberg', 'pandora', 'walmart', 'costco', 'cash for gold', 'gold buyer']
const AI_AGENCY_NEGATIVE_KEYWORDS = ['computer repair', 'staffing', 'employment', 'recruiting']

/** Keyed by pool slug; only the two pools this app shipped with have a built-in default. */
export const DEFAULT_SEARCH_CONFIGS: Record<string, SearchConfig> = {
  jeweler: { search_phrases: JEWELER_QUERIES, place_categories: JEWELER_CATEGORIES, negative_keywords: JEWELER_NEGATIVE_KEYWORDS },
  ai_agency: { search_phrases: AI_AGENCY_QUERIES, place_categories: AI_AGENCY_CATEGORIES, negative_keywords: AI_AGENCY_NEGATIVE_KEYWORDS },
}

export function defaultSearchConfigFor(pool: string): SearchConfig | null {
  return DEFAULT_SEARCH_CONFIGS[pool] ?? null
}
