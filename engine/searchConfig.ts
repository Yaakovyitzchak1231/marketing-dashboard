/**
 * Resolve a campaign's find-leads search config: approved profile items when
 * the campaign has any, else the pool's built-in default (engine/data/default-
 * search-configs.ts). A campaign-profile-items query lives here as a small
 * local query (not lib/campaign-profiles' approvedItems, which a parallel PR
 * is writing) — swap to approvedItems once that module is merged.
 */
import type { Queryable } from '../lib/db/types.ts'
import { defaultSearchConfigFor, type SearchConfig } from './data/default-search-configs.ts'

export interface ResolvedSearchConfig {
  config: SearchConfig
  /** "profile" or "built-in default for pool <slug>" — logged on the run. */
  source: string
  campaign_id: number | null
  /** The campaign's pool slug (lp.campaigns.pool): the pool default for the run when no explicit segment is given. */
  pool: string | null
}

/**
 * select name, value, config from lp.campaign_profile_items where campaign_id = $1
 * and kind = $2 and status = 'approved' order by sort, id
 * (a local query, per HELPER_COMMON.md — can switch to
 * lib/campaign-profiles' approvedItems() once that PR is merged).
 */
async function approvedValues(q: Queryable, campaignId: number, kind: string): Promise<string[]> {
  const { rows } = await q.query<{ value: string | null; name: string }>(
    `select name, value from lp.campaign_profile_items
      where campaign_id = $1 and kind = $2 and status = 'approved'
      order by sort, id`,
    [campaignId, kind],
  )
  return rows.map((r) => (r.value && r.value.trim()) || r.name).filter(Boolean)
}

/**
 * The campaign's pool (lp.campaigns.pool), for the built-in-default fallback
 * and for the run's "built-in default for pool X" log line.
 */
async function poolForCampaign(q: Queryable, campaignId: number): Promise<string | null> {
  const { rows } = await q.query<{ pool: string | null }>('select pool from lp.campaigns where id = $1', [campaignId])
  return rows[0]?.pool ?? null
}

/**
 * Resolve the search config for a find-leads run started for `campaignId`.
 * APPROVED campaign-profile items win; the pool's built-in default lists are
 * used ONLY when the campaign has none of the three kinds approved yet (so a
 * fresh campaign with no profile work done still gets a usable default for
 * the two pools this app shipped with, and an honest empty default otherwise).
 */
export async function resolveCampaignSearchConfig(q: Queryable, campaignId: number): Promise<ResolvedSearchConfig> {
  const [search_phrases, place_categories, negative_keywords, pool] = await Promise.all([
    approvedValues(q, campaignId, 'search_phrase'),
    approvedValues(q, campaignId, 'place_category'),
    approvedValues(q, campaignId, 'negative_keyword'),
    poolForCampaign(q, campaignId),
  ])
  const hasProfile = search_phrases.length > 0 || place_categories.length > 0 || negative_keywords.length > 0
  if (hasProfile) {
    return { config: { search_phrases, place_categories, negative_keywords }, source: 'profile', campaign_id: campaignId, pool }
  }
  const def = (pool && defaultSearchConfigFor(pool)) || { search_phrases: [], place_categories: [], negative_keywords: [] }
  return { config: def, source: `built-in default for pool ${pool ?? 'unknown'}`, campaign_id: campaignId, pool }
}
