/**
 * Which Maps results are real independent stores worth researching. Ported
 * from tapdash_scraper/scraper.py stage_filter (Oct 6, 2026), whose rules
 * produced the 4,128 new independent jewelers out of 30,854 unique places.
 * Pure: the cross-run dedupe (domain/phone already in Leads, or already kept
 * in this run) is done by the runner against the database.
 */
import { hostOf, isPlatform, parseCityState, regDomain, STATE_ABBR, US_STATES } from './domains.ts'
import type { MapsPlace } from './maps.ts'

/** Any pool slug (campaign-agnostic). 'jeweler' and 'ai_agency' keep their own curated heuristics below as legacy defaults; any other pool is classified generically from the campaign's place_categories/negative_keywords (opts.config). */
export type Segment = string

export const CHAIN_DOMAINS = new Set([
  'kay.com', 'zales.com', 'jared.com', 'signetjewelers.com', 'helzberg.com', 'pandora.net', 'brilliantearth.com', 'shaneco.com',
  'benbridge.com', 'tiffany.com', 'cartier.com', 'reeds.com', 'peoplesjewellers.com', 'banter.com', 'pagoda.com', 'piercingpagoda.com',
  'macys.com', 'jcpenney.com', 'walmart.com', 'costco.com', 'samsclub.com', 'kendrascott.com', 'mejuri.com', 'claires.com',
  'swarovski.com', 'davidyurman.com', 'bluenile.com', 'jamesallen.com', 'robbinsbros.com', 'diamondsdirect.com', 'jamesavery.com',
  'alexandani.com', 'rolex.com', 'bulgari.com', 'vancleefarpels.com', 'harrywinston.com', 'chopard.com', 'graff.com', 'debeers.com',
  'mayors.com', 'jewelryexchange.com', 'thejewelryexchange.com', 'fredmeyerjewelers.com', 'littmanjewelers.com',
  'diamondsinternational.com', 'effyjewelry.com', 'cashamerica.com', 'firstcash.com', 'ezpawn.com', 'pawnamerica.com',
  'valuepawn.com', 'superpawn.com', 'gordonsjewelers.com', 'belden.com', 'kirkfreeport.com', 'nahoku.com', 'rossimons.com',
  'charlesandcolvard.com', 'goldenmine.com', 'gorjana.com', 'ringsandthings.com', 'davidsbridal.com', 'nordstrom.com', 'dillards.com',
  'bloomingdales.com', 'saks.com', 'neimanmarcus.com', 'target.com', 'kohls.com', 'sears.com', 'boscovs.com', 'belk.com', 'fossil.com',
  'apmex.com', 'cashforgold.com', 'zadig.com', 'mclarenjewelry.com', 'sterlingjewelers.com', 'kayoutlet.com', 'marksandmorgan.com',
  'rogersjewelers.com', 'ernestjones.co.uk', 'diamondjewelersfactory.com', 'tourneau.com', 'watchesofswitzerland.com',
  'mayorsjewelers.com', 'chanel.com', 'louisvuitton.com', 'gucci.com', 'hermes.com', 'dior.com', 'tiffanyandco.com', 'messika.com',
  'boucheron.com', 'piaget.com', 'omegawatches.com', 'tagheuer.com', 'gleim.com', 'ross-simons.com', 'brilliance.com', 'ritani.com',
  'vrai.com', 'lovisa.com', 'aldoshoes.com', 'icing.com', 'charmingcharlie.com', 'spencersonline.com', 'hottopic.com', 'zumiez.com',
  'goldmart.com',
])

// Ported from scraper.py; stems like "kay jewel" now match "Kay Jewelers" (the Python \b after the
// stem never matched, so those chains were only caught by their domain).
export const CHAIN_NAME_RE = new RegExp(
  "\\b(kay jewel\\w*|kay outlet|zales|jared|helzberg|pandora|brilliant earth|shane co|ben bridge|tiffany|cartier|signet|reeds jewel\\w*|" +
    "peoples jewel\\w*|banter|piercing pagoda|kendra scott|mejuri|claire'?s|swarovski|david yurman|blue nile|james allen|robbins brothers|" +
    'diamonds direct|james avery|alex and ani|rolex boutique|bvlgari|bulgari|van cleef|harry winston|chopard|graff|de beers|mayors|' +
    "the jewelry exchange|fred meyer jewel\\w*|littman|diamonds international|effy|cash america|first ?cash|ezpawn|pawn|value pawn|" +
    "super pawn|gordon'?s jewel\\w*|kirk freeport|na hoku|macy'?s|jcpenney|walmart|costco|sam'?s club|nordstrom|dillard'?s|bloomingdale'?s?|" +
    "saks|neiman|target|kohl'?s|sears|boscov|belk|fossil|sterling jewel\\w*|marks & morgan|marks and morgan|rogers jewel\\w*|tourneau|" +
    'watches of switzerland|chanel|louis vuitton|gucci|herm[eè]s|dior|messika|boucheron|piaget|omega boutique|tag heuer|ross-simons|' +
    "vrai|lovisa|icing|spencer'?s|hot topic|cash for gold|we buy gold|gold buyers?|gold ?& ?silver buyers?|coin (shop|exchange)|" +
    'metal supply|refin(ery|ing)|piercing studio|tattoo|vape|smoke shop|tire|florist|bead store|beads?\\b|craft store|michaels|' +
    'hobby lobby|jo-?ann)\\b',
  'i',
)
const JEWEL_CAT_RE = /jewel|diamond|goldsmith|engagement|bridal|watch|silversmith|gemolog|gem\b|gold dealer|custom/i
const BAD_PRIMARY_RE =
  /pawn|buyer|coin dealer|supply|piercing|tattoo|pawnbroker|bullion|department store|clothing store|boutique$|gift shop|craft|bead|discount store|shopping mall|outlet mall|thrift|consignment|antique|tobacco|cell phone/i
const ALLOWED_PRIMARY = new Set([
  'Jewelry store', 'Jeweler', 'Jewelry designer', 'Jewelry repair service', 'Goldsmith', 'Diamond dealer', 'Jewelry appraiser',
  'Jewelry manufacturer', 'Wholesale jeweler', 'Silversmith', 'Watch store', 'Watch repair service', 'Gold dealer', 'Jewelry engraver',
  'Watch manufacturer', 'Gemologist', 'Jewellery store', 'Goldsmith shop',
])

// AI agencies / builders: Maps categories as Google names them. Untested at scale
// (the Oct 6 run was jewelers only); the filter keeps agencies and software/marketing
// studios and drops staffing, IT repair and big consultancies.
const AGENCY_CAT_RE = /software|internet marketing|marketing agency|web design|website designer|consultant|computer consultant|advertising agency|app develop|artificial intelligence|automation|digital agency/i
const AGENCY_BAD_RE = /computer repair|staffing|employment|recruit|cell phone|electronics store|school|university|college/i

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
  // Applies to every pool, including jeweler/ai_agency, on top of their own
  // curated checks below.
  const neg = opts.config?.negative_keywords
  if (neg && neg.length) {
    const hay = `${name} ${cats.join(' ')} ${domain}`.toLowerCase()
    if (neg.some((k) => k && hay.includes(String(k).toLowerCase()))) return { keep: false, reason: 'excluded_by_negative_keyword' }
  }

  if (segment === 'jeweler') {
    if (CHAIN_NAME_RE.test(name)) return { keep: false, reason: 'chain_or_nonjeweler_name' }
    if (CHAIN_DOMAINS.has(domain)) return { keep: false, reason: 'chain_domain' }
    if (requireCategory) {
      if (!cats.length || !JEWEL_CAT_RE.test(cats.join(' '))) return { keep: false, reason: 'not_jeweler_category' }
      if (BAD_PRIMARY_RE.test(cats[0])) return { keep: false, reason: 'pawn_buyer_or_other_primary' }
      if (!ALLOWED_PRIMARY.has(cats[0]) && !/jewel|diamond|goldsmith|\bgems?\b/i.test(name)) {
        return { keep: false, reason: 'primary_category_not_jeweler' }
      }
    }
  } else if (segment === 'ai_agency') {
    if (requireCategory) {
      if (!cats.length || !AGENCY_CAT_RE.test(cats.join(' '))) return { keep: false, reason: 'not_agency_category' }
      if (AGENCY_BAD_RE.test(cats[0])) return { keep: false, reason: 'not_agency_primary' }
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
