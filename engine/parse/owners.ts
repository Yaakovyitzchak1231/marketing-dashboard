/**
 * Extra owner-name and direct-email sources (opt-in engine stages), ported
 * from Tab's Oct 6 enrichment (tapdash_scraper/enrich.py + enrich2.py):
 *
 *  - reviews:   Google Maps reviews naming the owner ("Clint, the owner ...",
 *               owner replies "This is Ken the owner"). Measured the best new
 *               name source on Oct 6 (506 names). 2+ reviews naming the same
 *               person = high, one = medium. Late/former owners and relatives
 *               ("the owner's son") are dropped; "new owner" wins when present.
 *  - firstlast: "<First>" "<store>" <city> owner -> the owner's last name.
 *  - yelp:      Yelp "Business Owner" lines, only when the Yelp listing's name
 *               matches the store.
 *  - pattern:   the store's own published person address (sarah@, s.jones@)
 *               teaches the pattern; applied to the owner's name it is a GUESS
 *               (medium confidence, status 'guessed-hold', never sendable
 *               before verification).
 *  - facebook:  the store's own Facebook page (search), and an email the
 *               logged-out page exposes.
 *
 * Pure functions only (no network): the engine stages in
 * engine/ownerStages.ts call them on fetched data.
 */
import { EMAIL_RE, isPlaceholder, nameFromLocal, otherBusiness, validName, type NameHit } from './extract.ts'
import { shortStore, type SearchHit } from './search.ts'

// ------------------------------------------------------------------ reviews

export interface Review {
  snippet: string
  /** The owner's reply, when the provider returns it. */
  response?: string | null
}

const OWN_RX: RegExp[] = [
  /\b([A-Z][a-z]{2,12})(?:\s*,)?\s+(?:\(|-\s*)?(?:the\s+|who\s+is\s+the\s+|is\s+the\s+|who\s+owns|our\s+)?(?:new\s+)?(?:co-?owner|owner|proprietor|founder)s?\b/g,
  /\b(?:co-?owner|owner|proprietor|founder)s?(?:\s*,|\s*-|\s+named|\s+is|\s+was)?\s+([A-Z][a-z]{2,12})\b/g,
  /\b(?:owners?|owned\s+by)\s+([A-Z][a-z]{2,12})\s+(?:and|&)\s+([A-Z][a-z]{2,12})/g,
]
const STOPW = new Set(
  ('The This They She Her His And But Very Highly Great Best Store Shop What When Owner Thank Thanks Jewelry Jeweler Our Their ' +
    'Diamond Gold Just Super Also Definitely Absolutely Both Dad Mom Will Would Shout Special Wonderful Amazing Family Husband ' +
    'Wife Son Daughter Brother Sister Mr Mrs Miss Ms Big Huge Many').split(' '),
)
/** Mentions of a previous owner: not the person to email today. */
export const GONE_RX = /passed away|passed on|rest in peace|in memory|late (?:husband|wife|father|owner)|former owner|previous owner|old owner|retired|sold the (?:store|business)/i
const NEW_OWNER_RX = /new owner/i

export interface ReviewName {
  name: string
  ctx: string
  review: number
}

/** Owner first names in a store's reviews (enrich2.review_names). */
export function reviewNames(reviews: Review[], store: string, firstNames: Set<string>): ReviewName[] {
  const toks = new Set(shortStore(store).map((t) => t.toLowerCase()))
  const out: ReviewName[] = []
  reviews.forEach((rv, i) => {
    const txt = `${rv.snippet ?? ''} ${rv.response ?? ''}`
    const seen = new Set<string>()
    for (const rx of OWN_RX) {
      rx.lastIndex = 0
      for (const m of txt.matchAll(rx)) {
        for (const g of m.slice(1)) {
          if (!g || STOPW.has(g) || toks.has(g.toLowerCase()) || seen.has(g)) continue
          if (!validName(g, firstNames)) continue
          seen.add(g)
          const at = m.index ?? 0
          out.push({ name: g, ctx: txt.slice(Math.max(0, at - 80), at + m[0].length + 80), review: i })
        }
      }
    }
  })
  return out
}

/** Drop relatives and previous owners; when anyone is called the "new owner", keep only those (enrich.all_names). */
export function filterReviewNames(names: ReviewName[]): ReviewName[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let keep = names.filter(
    (n) =>
      !new RegExp(esc(n.name) + "\\W+(?:is\\s+)?(?:the\\s+)?(?:co-?)?owner['’]?s\\s+(?:son|daughter|wife|husband|brother|sister|mother|father|dad|mom|nephew|niece|grandson|granddaughter|partner)", 'i').test(n.ctx) &&
      !GONE_RX.test(n.ctx),
  )
  if (keep.some((n) => NEW_OWNER_RX.test(n.ctx))) keep = keep.filter((n) => NEW_OWNER_RX.test(n.ctx))
  return keep
}

export interface ReviewOwner {
  name: string
  confidence: 'high' | 'medium'
  reviews: number
  ctx: string
}

/** The most-named person in the reviews: 2+ separate reviews = high, one = medium. */
export function reviewOwner(reviews: Review[], store: string, firstNames: Set<string>): ReviewOwner | null {
  const names = filterReviewNames(reviewNames(reviews, store, firstNames))
  const by = new Map<string, { name: string; reviews: Set<number>; ctx: string }>()
  for (const n of names) {
    const k = n.name.toLowerCase()
    const cur = by.get(k) ?? { name: n.name, reviews: new Set<number>(), ctx: n.ctx }
    cur.reviews.add(n.review)
    by.set(k, cur)
  }
  let top: { name: string; reviews: Set<number>; ctx: string } | null = null
  for (const v of by.values()) if (!top || v.reviews.size > top.reviews.size) top = v
  if (!top) return null
  return { name: top.name, confidence: top.reviews.size >= 2 ? 'high' : 'medium', reviews: top.reviews.size, ctx: top.ctx.slice(0, 240) }
}

/** Serper /reviews JSON -> Review[] (snippet + owner response). */
export function reviewsFromSerper(j: unknown): { reviews: Review[]; next: string | null } {
  const o = (j ?? {}) as Record<string, unknown>
  const list = Array.isArray(o.reviews) ? (o.reviews as Record<string, unknown>[]) : []
  const reviews = list.map((r) => {
    const resp = r.response
    const response = typeof resp === 'string' ? resp : resp && typeof resp === 'object' ? String((resp as Record<string, unknown>).snippet ?? '') : null
    return { snippet: String(r.snippet ?? ''), response }
  })
  return { reviews, next: typeof o.nextPageToken === 'string' && o.nextPageToken ? o.nextPageToken : null }
}

// ------------------------------------------------------------------ firstlast

export function firstLastQuery(first: string, store: string, city: string | null): string {
  return `"${first}" "${store}" ${city ?? ''} owner`.replace(/\s+/g, ' ').trim()
}

const NOT_LAST = new Set('the and owner owners jewelers jewelry jewellers was is has his her our from who at of for with store shop'.split(' '))

export interface LastNameHit {
  last: string
  url: string
  ctx: string
  role: boolean
  on_site: boolean
}

/**
 * The owner's last name from snippets about THIS store (link on the store's
 * domain, or the snippet names the store): "<First> <Last>" right after the
 * first name. Names tied to another business are dropped.
 */
export function lastNameHits(hits: SearchHit[], first: string, store: string, domain: string): LastNameHit[] {
  const toks = shortStore(store).map((t) => t.toLowerCase()).filter((t) => t.length >= 4)
  const esc = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rx = new RegExp(`\\b${esc}\\s+(?:[A-Z]\\.\\s+)?([A-Z][a-z]{2,15}(?:-[A-Z][a-z]+)?)\\b`, 'g')
  const out: LastNameHit[] = []
  for (const h of hits) {
    const tx = `${h.title} . ${h.snippet}`
    const low = tx.toLowerCase()
    const onSite = !!domain && h.link.includes(domain)
    if (!(onSite || (toks.length && toks.some((t) => low.includes(t))))) continue
    const role = /owner|founder|president|proprietor|ceo|principal|jeweler|goldsmith/.test(low)
    for (const m of tx.matchAll(rx)) {
      const last = m[1]
      if (NOT_LAST.has(last.toLowerCase())) continue
      if (store.toLowerCase().split(/\s+/).includes(last.toLowerCase())) continue
      if (otherBusiness({ name: `${first} ${last}`, ctx: tx }, store, domain)) continue
      out.push({ last, url: h.link, ctx: tx.slice(0, 220), role, on_site: onSite })
    }
  }
  return out
}

/** Pick a last name: on-site or role-bearing snippets count double; needs a role or the store's own site. */
export function pickLastName(hits: LastNameHit[]): (LastNameHit & { score: number }) | null {
  const by = new Map<string, { best: LastNameHit; score: number }>()
  for (const h of hits) {
    const w = 1 + (h.role ? 1 : 0) + (h.on_site ? 1 : 0)
    const cur = by.get(h.last)
    if (!cur) by.set(h.last, { best: h, score: w })
    else {
      cur.score += w
      if (w > 1 + (cur.best.role ? 1 : 0) + (cur.best.on_site ? 1 : 0)) cur.best = h
    }
  }
  let top: { best: LastNameHit; score: number } | null = null
  for (const v of by.values()) if (!top || v.score > top.score) top = v
  if (!top || !(top.best.role || top.best.on_site)) return null
  return { ...top.best, score: top.score }
}

// ------------------------------------------------------------------ yelp

export function yelpQuery(store: string, city: string | null): string {
  return `site:yelp.com "${store}" ${city ?? ''} "Business Owner"`.replace(/\s+/g, ' ').trim()
}

const YELP_RX = /([A-Z][a-z]{2,12})\s+[A-Z]\.\s*(?:,|\.|-)?\s*Business Owner/g

/** Does a Yelp listing title ("Gem Co Jewelers - Towson, MD - Yelp") name this store? Every distinctive store word must appear. */
export function yelpTitleMatches(title: string, store: string): boolean {
  const head = title.split(/\s+[-–|]\s+/)[0].toLowerCase()
  const toks = shortStore(store).map((t) => t.toLowerCase())
  if (!toks.length) return head.replace(/[^a-z0-9]/g, '') === store.toLowerCase().replace(/[^a-z0-9]/g, '')
  return toks.every((t) => head.includes(t))
}

export interface YelpOwner {
  name: string
  url: string
  ctx: string
}

/** "Ken R. Business Owner" lines from yelp.com results whose listing is this store. */
export function yelpOwners(hits: SearchHit[], store: string, firstNames: Set<string>): YelpOwner[] {
  const out: YelpOwner[] = []
  for (const h of hits) {
    if (!/(^|\.)yelp\.com\//i.test(h.link.replace(/^https?:\/\//, ''))) continue
    if (!yelpTitleMatches(h.title, store)) continue
    const tx = `${h.title} . ${h.snippet}`
    YELP_RX.lastIndex = 0
    for (const m of tx.matchAll(YELP_RX)) {
      if (!validName(m[1], firstNames)) continue
      if (out.some((o) => o.name === m[1])) continue
      out.push({ name: m[1], url: h.link, ctx: tx.slice(0, 220) })
    }
  }
  return out
}

// ------------------------------------------------------------------ pattern

export interface PublishedEmail {
  email: string
  evidence_url: string
  first_name?: string | null
  last_name?: string | null
}

export interface PatternGuess {
  email: string
  pattern: string
  /** The published address the pattern was learned from. */
  learned_from: string
  evidence_url: string
  /** true = the published address IS the owner's (same first name), not a guess. */
  same_person: boolean
}

const EXAMPLE_PAIRS = new Set(['john smith', 'jane doe', 'john doe', 'your name', 'first last'])
const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')

/**
 * The owner's address in the pattern the store's own published person
 * addresses use (felicity@ -> first@; jon.smith@ -> first.last@;
 * enrich.learned_pattern). Only addresses on the store's domain, with a real
 * first name in the local part, not placeholders, teach a pattern. A
 * first-name-only pattern can't produce first.last forms.
 */
export function learnPattern(published: PublishedEmail[], domain: string, first: string, last: string | null, firstNames: Set<string>): PatternGuess | null {
  const f = letters(first)
  const l = letters(last ?? '')
  if (f.length < 2 || !domain) return null
  for (const p of published) {
    const e = p.email.toLowerCase().trim()
    if (!e.endsWith('@' + domain) || isPlaceholder(e, true)) continue
    const loc = e.split('@')[0]
    let pf = letters(p.first_name ?? '')
    let pl = letters(p.last_name ?? '')
    if (!pf) {
      const n = nameFromLocal(loc, firstNames)
      if (!n) continue
      pf = n.toLowerCase()
      const rest = loc.slice(loc.indexOf(pf) + pf.length).replace(/^[._-]/, '')
      if (/^[a-z]{2,}$/.test(rest)) pl = rest
    }
    if (!pf || EXAMPLE_PAIRS.has(`${pf} ${pl}`.trim())) continue
    if (f.length >= 3 && (pf === f || pf.startsWith(f) || f.startsWith(pf)) && loc.startsWith(pf)) {
      return { email: e, pattern: 'published', learned_from: e, evidence_url: p.evidence_url, same_person: true }
    }
    const forms: [string, string, string][] = [['first', pf, f]]
    if (pl && l) {
      forms.push(
        ['first.last', `${pf}.${pl}`, `${f}.${l}`],
        ['firstlast', pf + pl, f + l],
        ['flast', pf[0] + pl, f[0] + l],
        ['first_last', `${pf}_${pl}`, `${f}_${l}`],
        ['f.last', `${pf[0]}.${pl}`, `${f[0]}.${l}`],
      )
    } else if (pl && !l) {
      continue // their pattern needs a last name we don't have
    }
    for (const [k, theirs, ours] of forms) {
      if (loc === theirs) return { email: `${ours}@${domain}`, pattern: k, learned_from: e, evidence_url: p.evidence_url, same_person: false }
    }
  }
  return null
}

// ------------------------------------------------------------------ facebook

export function facebookQuery(store: string, city: string | null, state: string | null): string {
  return `"${store}" ${city ?? ''} ${state ?? ''} site:facebook.com`.replace(/\s+/g, ' ').trim()
}

const FB_NOT_PAGE = /^(?:profile\.php|people|groups|events|watch|marketplace|share|sharer|photo|photos|story\.php|permalink\.php|login|public|hashtag|pages\/category|reel|reels|videos)$/i

/**
 * The store's own Facebook page among search hits: a root page
 * (facebook.com/<slug>), whose title carries the store's name or whose slug
 * carries its distinctive words. Personal profiles and posts are skipped.
 */
export function facebookPageFromHits(hits: SearchHit[], store: string): string | null {
  const toks = shortStore(store).map((t) => t.toLowerCase())
  const phrase = store.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  for (const h of hits) {
    let u: URL
    try {
      u = new URL(h.link)
    } catch {
      continue
    }
    if (!/(^|\.)facebook\.com$/i.test(u.hostname)) continue
    const segs = u.pathname.split('/').filter(Boolean)
    if (segs.length !== 1 || FB_NOT_PAGE.test(segs[0])) continue
    const title = h.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ')
    const slug = segs[0].toLowerCase()
    if ((phrase && title.includes(phrase)) || (toks.length && toks.every((t) => slug.includes(t)))) return `https://www.facebook.com/${segs[0]}`
  }
  return null
}

/** Is the logged-out page a login wall rather than the page itself? */
export function facebookWalled(html: string): boolean {
  return /id="login_form"|You must log in to continue|Log in to Facebook|checkpoint\/block/i.test(html) && !/"page_id"|"pageID"|og:title/i.test(html)
}

/** Emails a logged-out Facebook page exposes (JSON blobs, mailto, intro text). Facebook's own and placeholder addresses dropped. */
export function facebookEmails(html: string): string[] {
  const text = html
    .replace(/\\u0040/gi, '@')
    .replace(/\\\//g, '/')
    .replace(/&#064;|&#x40;/gi, '@')
  const out = new Set<string>()
  for (const m of text.match(EMAIL_RE) ?? []) {
    const e = m.toLowerCase().replace(/^mailto:/, '').replace(/[.]+$/, '')
    const dom = e.split('@')[1] ?? ''
    if (/(^|\.)(facebook|facebookmail|fb|fbcdn|instagram|meta|whatsapp|sentry|example)\.(com|net|io)$/.test(dom)) continue
    if (/\.(png|jpe?g|gif|webp|svg|js|css)$/.test(e) || isPlaceholder(e, true)) continue
    out.add(e)
  }
  return [...out]
}

// ------------------------------------------------------------------ combine

export interface BaseOwner {
  name: string
  how: string
  evidence_url: string
  confidence: 'high' | 'medium' | 'low'
}

const RANK = { high: 3, medium: 2, low: 1 } as const

/**
 * Merge the extra sources into the owner the website/search evidence chose
 * (enrich.choose_name order): a review/Yelp name that agrees with the site's
 * first name raises it to high ("review_corroborated"); with no site owner the
 * best extra source stands; a stronger extra source replaces a low one.
 */
export function mergeOwner(
  base: BaseOwner | null,
  extra: { review?: (ReviewOwner & { url: string }) | null; yelp?: YelpOwner[] },
): (BaseOwner & { note: string | null }) | null {
  const cands: BaseOwner[] = []
  if (extra.review) cands.push({ name: extra.review.name, how: 'maps_review_owner', evidence_url: extra.review.url, confidence: extra.review.confidence })
  for (const y of extra.yelp ?? []) cands.push({ name: y.name, how: 'yelp_business_owner', evidence_url: y.url, confidence: 'medium' })
  if (!base && !cands.length) return null
  if (base) {
    const bf = base.name.split(' ')[0].toLowerCase()
    const agree = cands.find((c) => c.name.split(' ')[0].toLowerCase() === bf)
    if (agree && base.confidence !== 'high') return { ...base, confidence: 'high', how: `${base.how}+${agree.how}_corroborated`, note: `confirmed by ${agree.how === 'maps_review_owner' ? 'Maps reviews' : 'Yelp'}` }
    const best = cands.sort((a, b) => RANK[b.confidence] - RANK[a.confidence])[0]
    if (best && RANK[best.confidence] > RANK[base.confidence]) return { ...best, note: `replaced a ${base.confidence}-confidence name (${base.name})` }
    return { ...base, note: null }
  }
  const best = cands.sort((a, b) => RANK[b.confidence] - RANK[a.confidence])[0]
  return { ...best, note: null }
}

export type { NameHit }
