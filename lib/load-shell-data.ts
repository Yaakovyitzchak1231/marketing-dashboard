import type {
  Overview,
  CampaignList,
  CampaignTrend,
  Freshness,
} from '@/lib/api-types'
import { DEFAULT_RANGE } from '@/lib/range'

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
  cookie?: string,
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

export async function loadShellData(
  campaignId: string | null,
  suppliedFreshness?: Freshness,
): Promise<ShellData> {
  // Server-side `fetch` requires an absolute URL. A relative path works in a
  // browser but throws "Invalid URL" in a Server Component, which surfaced as a
  // 500 on `/`. VERCEL_URL is set by Vercel; PORT covers local runs.
  //
  // The PORT fallback matters more than it looks: without it the self-fetch
  // targeted http://127.0.0.1:3000 while the server actually listened on
  // whatever port `next start -p N` was given. Every fetch then failed, was
  // swallowed by the catch, and the page rendered the honest empty state with
  // real data sitting in the database.
  const port = process.env.PORT ?? '3000'
  const base =
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://127.0.0.1:${port}`)

  const { cookies } = await import('next/headers')
  const cookie = (await cookies()).toString()

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
    // No timestamp can be derived client-side, so with no supplied snapshot
    // metadata the honest value is null -- the freshness line then renders a
    // dash and says the collection failed, rather than guessing "now".
    generatedAt: null,
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
