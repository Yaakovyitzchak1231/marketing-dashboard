/**
 * Per-pool Maps filter heuristics, as data — not branches in the filter.
 *
 * engine/parse/filter.ts used to hard-code `if (segment === 'jeweler') ... else
 * if (segment === 'ai_agency') ...`. Those two pools' curated rules (ported
 * from the Oct 6, 2026 jeweler scraper run) now live here as registry entries;
 * any other pool falls back to the campaign's configured place categories.
 * Adding a pool with curated heuristics is adding an entry here — the filter
 * itself never grows another branch.
 */
export interface PoolHeuristicReasons {
  chainName: string
  chainDomain: string
  notCategory: string
  badPrimary: string
  primaryNotPool: string
}

export interface PoolHeuristics {
  /** Domains that always mark a chain (or otherwise excluded) business. */
  chainDomains?: Set<string>
  /** Name pattern matching chain / non-pool business names. Checked before categories. */
  chainNameRe?: RegExp
  /**
   * When true, the chain checks run even if requireCategory is false (the
   * jeweler behavior: a Kay Jewelers is dropped even when the caller does
   * not require category data).
   */
  chainsAlways?: boolean
  /** A Maps category must match this to count as this pool. */
  categoryRe: RegExp
  /** Primary-category pattern that disqualifies outright (e.g. pawn for jewelers). */
  badPrimaryRe?: RegExp
  /** Allowed primary Maps categories; any other primary needs the name fallback to match. */
  allowedPrimary?: Set<string>
  /** Name pattern that rescues a place whose primary category is not in allowedPrimary. */
  primaryNameFallbackRe?: RegExp
  /** Plain words for the drop reasons, shown on the Find leads screen. */
  reasons: PoolHeuristicReasons
}

const JEWELER_CHAIN_DOMAINS = new Set([
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
const JEWELER_CHAIN_NAME_RE = new RegExp(
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

const JEWELER_ALLOWED_PRIMARY = new Set([
  'Jewelry store', 'Jeweler', 'Jewelry designer', 'Jewelry repair service', 'Goldsmith', 'Diamond dealer', 'Jewelry appraiser',
  'Jewelry manufacturer', 'Wholesale jeweler', 'Silversmith', 'Watch store', 'Watch repair service', 'Gold dealer', 'Jewelry engraver',
  'Watch manufacturer', 'Gemologist', 'Jewellery store', 'Goldsmith shop',
])

/** Keyed by pool slug. Pools with no entry are classified generically from the campaign's configured place categories. */
export const POOL_HEURISTICS: Record<string, PoolHeuristics> = {
  jeweler: {
    chainDomains: JEWELER_CHAIN_DOMAINS,
    chainNameRe: JEWELER_CHAIN_NAME_RE,
    chainsAlways: true,
    categoryRe: /jewel|diamond|goldsmith|engagement|bridal|watch|silversmith|gemolog|gem\b|gold dealer|custom/i,
    badPrimaryRe:
      /pawn|buyer|coin dealer|supply|piercing|tattoo|pawnbroker|bullion|department store|clothing store|boutique$|gift shop|craft|bead|discount store|shopping mall|outlet mall|thrift|consignment|antique|tobacco|cell phone/i,
    allowedPrimary: JEWELER_ALLOWED_PRIMARY,
    primaryNameFallbackRe: /jewel|diamond|goldsmith|\bgems?\b/i,
    reasons: {
      chainName: 'chain_or_nonjeweler_name',
      chainDomain: 'chain_domain',
      notCategory: 'not_jeweler_category',
      badPrimary: 'pawn_buyer_or_other_primary',
      primaryNotPool: 'primary_category_not_jeweler',
    },
  },
  // AI agencies / builders: Maps categories as Google names them. Untested at scale
  // (the Oct 6 run was jewelers only); the filter keeps agencies and software/marketing
  // studios and drops staffing, IT repair and big consultancies.
  ai_agency: {
    categoryRe:
      /software|internet marketing|marketing agency|web design|website designer|consultant|computer consultant|advertising agency|app develop|artificial intelligence|automation|digital agency/i,
    badPrimaryRe: /computer repair|staffing|employment|recruit|cell phone|electronics store|school|university|college/i,
    reasons: {
      chainName: 'chain_or_nonagency_name',
      chainDomain: 'chain_domain',
      notCategory: 'not_agency_category',
      badPrimary: 'not_agency_primary',
      primaryNotPool: 'not_agency_primary',
    },
  },
}

/** The curated heuristics for a pool, or undefined when the pool is classified generically. */
export function heuristicsFor(pool: string): PoolHeuristics | undefined {
  return POOL_HEURISTICS[pool]
}
