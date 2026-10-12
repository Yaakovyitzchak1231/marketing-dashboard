/**
 * Which Maps results are real independent stores worth researching. The
 * jeweler rules were ported from tapdash_scraper/scraper.py stage_filter
 * (Oct 6, 2026), whose rules produced the 4,128 new independent jewelers out
 * of 30,854 unique places. Pure: the cross-run dedupe (domain/phone already
 * in Leads, or already kept in this run) is done by the runner against the
 * database.
 *
 * Campaign-agnostic: per-pool curated heuristics live in
 * engine/data/pool-heuristics.ts (jeweler and ai_agency are the two entries
 * so far). A pool with no entry is classified generically from the campaign's
 * configured place_categories / negative_keywords (opts.config) — no new
 * branches here when a pool is added.
 */
import { hostOf, isPlatform, parseCityState, regDomain, STATE_ABBR, US_STATES } from './domains.ts'
import type { MapsPlace } from './maps.ts'
import { heuristicsFor } from '../data/pool-heuristics.ts'

/** Any pool slug (campaign-agnostic). */
export type Segment = string

export type FilterResult =
  | { keep: true; domain: string; city: string | null; state: string | null }
  | { keep: false; reason: string }

/** One Maps place -> keep (with its domain) or a plain drop reason. */
export function classifyPlace(
  p: MapsPlace & { metro?: string | null },
  segment: Segment,
  opts: { requireCategory?: boolean; config?: { place_categories?: string[]; negative_keywords?: string[] } } = {},
): FilterResult {
  const requireCategory = opts.requireCategory !== false || (p.categories ?? []).length > 0
  const name = p.name ?? ''
  const cats = p.categories ?? []
  const host = hostOf(p.website)
  const domain = host ? regDomain(host) : ''
  const fromAddr = parseCityState(p.address)
  let city = fromAddr.city ?? p.city ?? null
  let state = fromAddr.state ?? (p.state ? STATE_ABBR[p.state] ?? p.state : null)
  if (state && !US_STATES.has(state)) return { keep: false, reason: 'non_us' }

  // Generic, campaign-agnostic exclusion: the campaign's own negative keywords
  // (from its approved profile items, or the pool's built-in default list).
  // Applies to every pool, including the curated ones, on top of their own
  // heuristics below.
  const neg = opts.config?.negative_keywords
  if (neg && neg.length) {
    const hay = `${name} ${cats.join(' ')} ${domain}`.toLowerCase()
    if (neg.some((k) => k && hay.includes(String(k).toLowerCase()))) return { keep: false, reason: 'excluded_by_negative_keyword' }
  }

  const h = heuristicsFor(segment)
  if (h) {
    // A pool with curated heuristics: chain/name checks, then category gating.
    const checkChains = h.chainsAlways === true || requireCategory
    if (checkChains) {
      if (h.chainNameRe && h.chainNameRe.test(name)) return { keep: false, reason: h.reasons.chainName }
      if (h.chainDomains && h.chainDomains.has(domain)) return { keep: false, reason: h.reasons.chainDomain }
    }
    if (requireCategory) {
      if (!cats.length || !h.categoryRe.test(cats.join(' '))) return { keep: false, reason: h.reasons.notCategory }
      if (h.badPrimaryRe && h.badPrimaryRe.test(cats[0])) return { keep: false, reason: h.reasons.badPrimary }
      if (h.allowedPrimary && !h.allowedPrimary.has(cats[0]) && !(h.primaryNameFallbackRe && h.primaryNameFallbackRe.test(name))) {
        return { keep: false, reason: h.reasons.primaryNotPool }
      }
    }
  } else if (requireCategory) {
    // A campaign-agnostic pool with no curated heuristics of its own: gate
    // purely on the campaign's configured place categories (from its approved
    // profile items). No categories configured -> accept any place that has
    // at least one Maps category; we can't be pickier generically.
    const wantedCats = opts.config?.place_categories ?? []
    if (!cats.length) return { keep: false, reason: 'no_category_data' }
    if (wantedCats.length) {
      const wanted = wantedCats.map((c) => c.toLowerCase())
      const matched = cats.some((c) => wanted.some((w) => c.toLowerCase().includes(w) || w.includes(c.toLowerCase())))
      if (!matched) return { keep: false, reason: 'not_in_campaign_categories' }
    }
  }
  if (!city || !state) {
    const [mc, ms] = String(p.metro ?? '').split(', ')
    city = city || mc || null
    state = state || ms || null
  }
  if (!host) return { keep: false, reason: 'no_website' }
  if (isPlatform(host)) return { keep: false, reason: 'website_is_platform_page' }
  return { keep: true, domain, city, state }
}

/** Plain words for the drop reasons, shown on the Find leads screen. */
export const DROP_REASON_WORDS: Record<string, string> = {
  non_us: 'outside the US',
  chain_or_nonjeweler_name: 'chain, pawn or not a jeweler (by name)',
  chain_or_nonagency_name: 'chain or not an agency (by name)',
  chain_domain: 'chain (by website)',
  not_jeweler_category: 'not a jewelry business on Maps',
  pawn_buyer_or_other_primary: 'pawn, gold buyer or other main category',
  primary_category_not_jeweler: 'main Maps category is not jewelry',
  not_agency_category: 'not an agency/software business on Maps',
  not_agency_primary: 'main Maps category is not an agency',
  no_website: 'no website',
  website_is_platform_page: 'website is a Facebook/Yelp/builder page',
  excluded_by_negative_keyword: "matches the campaign's negative keywords",
  no_category_data: 'Maps gave no category to check',
  not_in_campaign_categories: "not one of the campaign's configured categories",
  multi_location_6plus: 'same website at 6+ locations (a chain)',
  already_in_leads: 'already in your leads',
  dup_in_this_job: 'duplicate within this job',
  over_max: 'past the job\'s business limit',
}
