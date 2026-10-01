import type {
  Overview,
  CampaignList,
  CampaignTrend,
  Freshness,
} from '@/lib/api-types'
import { DEFAULT_RANGE } from '@/lib/range'
import { getBaseUrl } from '@/lib/base-url'

/**
 * The fetch layer for the app shell.
 *
 * This is a Server Component data loader. It is deliberately the ONLY place
 * that talks to the network, which means the render path is pure and its
 * honesty is testable without a server.
 *
 * The failure contract is the important part, and it is the same one the
 * format layer enforces everywhere else:
 *
 *   - A route that errors, 404s, or returns something that is not the shape it
 *     claims to be yields `null`. NEVER a zeroed object.
 *   - A missing overview is a KNOWN absence, so it is reported as a failed
 *     collection rather than silently rendering an empty row as though the
 *     account genuinely sent nothing.
 *   - A missing trend does not fail the page. One broken chart is not a broken
 *     dashboard.
 */

export type ShellData = {
  overview: Overview | null
  campaigns: CampaignList | null
  trend: CampaignTrend | null
  freshness: Freshness
  trendFailed: boolean
}

/** The shape each route must have before we will believe it. */
const SHAPES = {
  overview: (v: unknown): v is Overview =>
    typeof v === 'object' && v !== null && 'emails_sent' in v,
  campaigns: (v: unknown): v is CampaignList =>
    typeof v === 'object' && v !== null && Array.isArray((v as CampaignList).campaigns),
  trend: (v: unknown): v is CampaignTrend =>
    typeof v === 'object' && v !== null && Array.isArray((v as CampaignTrend).trend),
}

/**
 * Fetch one route and return its body, or null if anything at all is wrong.
 *
 * `revalidate: 0` because this page is a live view of a snapshot the collector
 * rewrites; a cached copy would show figures the database no longer holds,
 * which is the same class of lie as a stale timestamp.
 */
async function getJson<T>(
  url: string,
  guard: (v: unknown) => v is T,
  cookie?: string | null,
): Promise<T | null> {
  try {
    // The API routes sit behind auth, so the server-side self-fetch has to
    // carry the caller's session cookie. Without it every route answers 401 and
    // the page renders as though the database were empty.
    const res = await fetch(url, {
      cache: 'no-store',
      headers: cookie ? { cookie } : undefined,
    })
    if (!res.ok) return null
    const body: unknown = await res.json()
    // A 200 can still carry `{ error: ... }`. The guard is what stops that
    // from becoming an empty KPI row that reads like real data.
    return guard(body) ? body : null
  } catch {
    return null
  }
}

/**
 * The caller's session cookie, as a header string.
 *
 * The API routes sit behind auth, so the server-side self-fetch has to carry
 * the session or every route answers 401 and the page renders as though the
 * database were empty.
 *
 * Reading the cookie jar requires a request scope, which a Server Component
 * has and a plain unit test does not. Rather than making the caller thread a
 * cookie through every call site, this returns null outside a request scope:
 * the fetch then goes out unauthenticated, the route answers 401, and
 * `getJson` returns null -- which is exactly the documented failure contract
 * ("a route that errors yields null, never a zeroed object"). The failure is
 * honest rather than fatal, and the test does not have to fake a request to
 * exercise the loader.
 */
async function requestCookieHeader(): Promise<string | null> {
  try {
    const { cookies } = await import('next/headers')
    return (await cookies()).toString()
  } catch {
    // No request scope: not an error, just no session to forward.
    return null
  }
}

export async function loadShellData(
  campaignId: string | null,
  suppliedFreshness?: Freshness,
): Promise<ShellData> {
  const base = getBaseUrl()
  const cookie = await requestCookieHeader()

  const [overview, campaigns, trendResult] = await Promise.all([
    getJson<Overview>(`${base}/api/overview?range=${DEFAULT_RANGE}`, SHAPES.overview, cookie),
    getJson<CampaignList>(`${base}/api/campaigns?range=${DEFAULT_RANGE}`, SHAPES.campaigns, cookie),
    campaignId
      ? getJson<CampaignTrend>(
          `${base}/api/campaigns/${campaignId}/trend?range=30d`,
          SHAPES.trend,
          cookie,
        )
      : Promise.resolve(null),
  ])

  // The trend was requested and came back empty -> that is a failed request,
  // not an empty history. An empty history is `[]` inside a valid payload.
  const trendFailed = campaignId !== null && trendResult === null

  const freshness: Freshness = suppliedFreshness ?? {
    // The overview route reports the `generated_at` of the snapshot it just
    // read, so this is the real collection time when one exists. Previously
    // this was hardcoded to null, which meant the freshness line could never
    // show a date no matter how the collector behaved -- the whole line was
    // decorative. A null here means the row carries no timestamp.
    generatedAt: overview?.generated_at ?? null,
    // A missing overview is a failed fetch. An overview of all-nulls is a
    // source that reported nothing, which is a different fact.
    collectionFailed: overview === null,
  }

  return {
    overview,
    campaigns,
    trend: trendResult,
    freshness,
    trendFailed,
  }
}
