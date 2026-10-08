/**
 * The opt-in extra owner stages of a Find-leads job (reviews, yelp, firstlast,
 * facebook, pattern), run between the owner search and the build. Each item
 * at stage 'owner' gets data.extras and moves to stage 'extras'; the build
 * reads it through toResearchResult (findLeads.ts) and writes it through
 * lib/research/apply.ts like everything else: evidence or nothing.
 *
 * Network goes through the runner's search provider (Serper or SearXNG) and,
 * for Facebook pages, a direct logged-out fetch; every call has a deadline and
 * a per-host gap. Without a search provider the search-based stages are
 * skipped with a plain note on the run; 'pattern' needs no network.
 */
import type { Db } from '../lib/db/types.ts'
import { HostLimiter, request, sleep, backoffMs, type HttpResponse } from './io/http.ts'
import type { SearchProvider } from './io/search.ts'
import { chooseOwner, type NameHit } from './parse/extract.ts'
import {
  facebookEmails, facebookPageFromHits, facebookQuery, facebookWalled, firstLastQuery, lastNameHits, learnPattern, mergeOwner,
  pickLastName, reviewOwner, yelpOwners, yelpQuery, type Review, type ReviewOwner, type YelpOwner,
} from './parse/owners.ts'
import type { MapsPlace } from './parse/maps.ts'
import type { EngineStage } from './params.ts'
import { addNote, pendingItems, setStage, updateItem } from './store.ts'

export interface OwnerExtras {
  review?: (ReviewOwner & { url: string }) | null
  reviews_read?: number
  yelp?: YelpOwner[]
  last?: { last: string; url: string; ctx: string } | null
  facebook?: { page: string | null; emails: string[]; walled?: boolean; error?: string } | null
  pattern?: { email: string; pattern: string; learned_from: string; evidence_url: string; same_person: boolean } | null
  skipped?: string[]
}

export interface OwnerStageDeps {
  agent: string
  search: SearchProvider | null
  fetch?: (url: string, o?: Parameters<typeof request>[1]) => Promise<HttpResponse>
  /** Per-host politeness. Defaults: search 1 at a time with 300 ms gap; facebook.com 1 at a time, 4 s gap. */
  limiter?: HostLimiter
  fbLimiter?: HostLimiter
  /** Per-call deadline (default 45 s). */
  deadlineMs?: number
  beat: () => Promise<void>
}

/** Stages that need a search provider. */
const NEEDS_SEARCH: EngineStage[] = ['reviews', 'yelp', 'firstlast', 'facebook']

function withDeadline<T>(pr: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: gave up after ${Math.round(ms / 1000)} s`)), ms)
    pr.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

interface SlimForExtras {
  emails?: { email: string; evidence_url: string; how: string }[]
  names?: { name: string; how: string; url: string; ctx: string }[]
  blocked?: boolean
}

/** The owner the website + owner search chose so far (same rule as the build). */
export function baseOwnerOf(data: Record<string, unknown>) {
  const crawl = (data.crawl ?? null) as SlimForExtras | null
  const os = (data.owner_search ?? null) as { search_names?: { name: string; how: string; url: string; ctx: string }[] } | null
  const names = [...(crawl?.names ?? []), ...(os?.search_names ?? []).map((n) => ({ ...n, how: 'search_owner' }))]
  return chooseOwner(names as (NameHit & { url: string })[], (crawl?.emails ?? []).map((e) => e.email))
}

export function mapsUrl(place: Pick<MapsPlace, 'cid' | 'place_id'>): string | null {
  if (place.cid) return `https://maps.google.com/?cid=${encodeURIComponent(place.cid)}`
  return null
}

/** Run the selected extra stages over every item waiting at stage 'owner'. */
export async function runOwnerExtras(db: Db, runId: number, stages: EngineStage[], deps: OwnerStageDeps, firstNames: Set<string>): Promise<void> {
  const want = new Set(stages)
  const notes: string[] = []
  if (!deps.search) {
    const off = NEEDS_SEARCH.filter((s) => want.has(s))
    if (off.length) notes.push(`Skipped ${off.join(', ')}: no search provider is set on the runner (SERPER_API_KEY or SEARXNG_URL).`)
    for (const s of off) want.delete(s)
  } else if (want.has('reviews') && !deps.search.reviews) {
    notes.push(`Skipped Maps reviews: the ${deps.search.name} search provider has no reviews endpoint (Serper has one; SearXNG does not).`)
    want.delete('reviews')
  }
  for (const n of notes) await addNote(db, runId, n)
  if (!want.size) {
    await db.query(`update lp.engine_items set stage = 'extras' where run_id = $1 and kind = 'place' and stage = 'owner' and status = 'pending'`, [runId])
    return
  }
  await setStage(db, runId, 'extras')
  const fetcher = deps.fetch ?? request
  const lim = deps.limiter ?? new HostLimiter(1, 300)
  const fbLim = deps.fbLimiter ?? new HostLimiter(1, 4000)
  const dl = deps.deadlineMs ?? 45_000
  const search = deps.search
  const q = async (query: string) => {
    await lim.acquire('search')
    try {
      return await withDeadline(search!.search(query), dl, 'search')
    } finally {
      lim.release('search')
    }
  }

  for (;;) {
    const batch = await pendingItems(db, runId, 'place', 'owner', 20, 5)
    if (!batch.length) break
    for (const it of batch) {
      const place = (it.data.place ?? {}) as MapsPlace
      const crawl = (it.data.crawl ?? null) as SlimForExtras | null
      const os = (it.data.owner_search ?? null) as { search_emails?: { email: string; url: string }[] } | null
      const domain = String(it.data.domain ?? '')
      const city = (it.data.city as string | null) ?? place.city ?? null
      const state = (it.data.state as string | null) ?? place.state ?? null
      const ex: OwnerExtras = { ...((it.data.extras ?? {}) as OwnerExtras) }
      try {
        const base = baseOwnerOf(it.data)
        const highAlready = base?.confidence === 'high'

        if (want.has('reviews') && ex.review === undefined) {
          const url = mapsUrl(place)
          const fid = place.place_id && place.place_id.includes(':') ? place.place_id : null
          if (!place.cid && !fid) ex.review = null
          else if (highAlready) ex.review = null // enrich.py read reviews only for nameless or med/low names
          else {
            const revs: Review[] = []
            let tok: string | null = null
            for (let page = 0; page < 2; page++) {
              await lim.acquire('search')
              try {
                const r: { reviews: Review[]; next: string | null } = await withDeadline(search!.reviews!({ cid: place.cid, fid }, tok), dl, 'reviews')
                revs.push(...r.reviews)
                tok = r.next
              } finally {
                lim.release('search')
              }
              if (!tok) break
            }
            ex.reviews_read = revs.length
            const ro = reviewOwner(revs, place.name, firstNames)
            ex.review = ro && url ? { ...ro, url } : null
          }
        }

        if (want.has('yelp') && ex.yelp === undefined) {
          ex.yelp = highAlready ? [] : yelpOwners(await q(yelpQuery(place.name, city)), place.name, firstNames).slice(0, 5)
        }

        const merged = mergeOwner(base, { review: ex.review ?? null, yelp: ex.yelp ?? [] })

        if (want.has('firstlast') && ex.last === undefined) {
          if (merged && !merged.name.includes(' ')) {
            const pick = pickLastName(lastNameHits(await q(firstLastQuery(merged.name, place.name, city)), merged.name, place.name, domain))
            ex.last = pick ? { last: pick.last, url: pick.url, ctx: pick.ctx } : null
          } else ex.last = null
        }

        if (want.has('facebook') && ex.facebook === undefined) {
          if ((crawl?.emails ?? []).length) ex.facebook = null // the site already gave an address
          else {
            const page = facebookPageFromHits(await q(facebookQuery(place.name, city, state)), place.name)
            ex.facebook = { page, emails: [] }
            if (page) {
              await fbLim.acquire('facebook.com')
              try {
                const r = await withDeadline(fetcher(page, { timeoutMs: 20_000 }), dl, 'facebook')
                if (r.status === 200 && facebookWalled(r.body)) ex.facebook.walled = true
                else if (r.status === 200) ex.facebook.emails = facebookEmails(r.body).slice(0, 5)
                else ex.facebook.error = `HTTP ${r.status}`
              } catch (e) {
                ex.facebook.error = (e as Error).message.slice(0, 120)
              } finally {
                fbLim.release('facebook.com')
              }
            }
          }
        }

        if (want.has('pattern') && ex.pattern === undefined) {
          if (merged && domain) {
            const [first, ...rest] = merged.name.split(' ')
            const last = rest.length ? rest[rest.length - 1] : ex.last?.last ?? null
            const published = [
              ...(crawl?.emails ?? []).map((e) => ({ email: e.email, evidence_url: e.evidence_url })),
              ...(os?.search_emails ?? []).map((e) => ({ email: e.email, evidence_url: e.url })),
            ]
            ex.pattern = learnPattern(published, domain, first, last, firstNames)
          } else ex.pattern = null
        }

        // success does not count as an attempt: attempts are shared across stages and the build has its own cap
        await updateItem(db, it.id, { stage: 'extras', data: { extras: ex }, error: null })
      } catch (e) {
        const lastTry = it.attempts + 1 >= 3
        await updateItem(db, it.id, { ...(lastTry ? { stage: 'extras' } : {}), data: { extras: ex }, error: `owner extras: ${(e as Error).message.slice(0, 200)}`, attempt: true })
        await sleep(backoffMs(it.attempts))
      }
      await deps.beat()
    }
  }
}
