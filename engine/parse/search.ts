/**
 * Web-search snippets -> owner names and on-domain emails (enrich.py
 * search_stage, scraper.py "search" fallback for Shopify stores that 429'd).
 * Provider-neutral: Serper and SearXNG results are both reduced to SearchHit.
 */
import { namesFromText, otherBusiness, isPlaceholder, type NameHit } from './extract.ts'

export interface SearchHit {
  title: string
  link: string
  snippet: string
}

/** Serper /search JSON -> hits (organic + knowledge graph + people-also-ask). */
export function hitsFromSerper(j: unknown): SearchHit[] {
  const o = (j ?? {}) as Record<string, unknown>
  const out: SearchHit[] = []
  for (const r of (Array.isArray(o.organic) ? o.organic : []) as Record<string, unknown>[]) {
    out.push({ title: String(r.title ?? ''), link: String(r.link ?? ''), snippet: String(r.snippet ?? '') })
  }
  if (o.knowledgeGraph && typeof o.knowledgeGraph === 'object') {
    const kg = o.knowledgeGraph as Record<string, unknown>
    out.push({ title: String(kg.title ?? ''), link: String(kg.website ?? 'knowledgeGraph'), snippet: JSON.stringify(kg) })
  }
  for (const r of (Array.isArray(o.peopleAlsoAsk) ? o.peopleAlsoAsk : []) as Record<string, unknown>[]) {
    out.push({ title: String(r.question ?? ''), link: String(r.link ?? ''), snippet: String(r.snippet ?? '') })
  }
  return out
}

/** SearXNG /search?format=json -> hits. */
export function hitsFromSearxng(j: unknown): SearchHit[] {
  const o = (j ?? {}) as Record<string, unknown>
  return ((Array.isArray(o.results) ? o.results : []) as Record<string, unknown>[]).map((r) => ({
    title: String(r.title ?? ''),
    link: String(r.url ?? ''),
    snippet: String(r.content ?? ''),
  }))
}

/** Distinctive words of a store name ("Smith & Sons Fine Jewelers" -> ["Smith", "Sons"]). */
export function shortStore(name: string): string[] {
  const n = name.replace(/\b(jewel(?:ry|ers?|lery|lers)|fine|diamonds?|inc|llc|co|company|the|and|store|shop|repair|custom|designs?|gallery|studio|ltd)\b|&/gi, ' ')
  return n.match(/[A-Za-z']{3,}/g) ?? []
}

export function ownerQuery(store: string, city: string | null, state: string | null): string {
  return `"${store}" ${city ?? ''} ${state ?? ''} owner OR founder`.replace(/\s+/g, ' ').trim()
}

/**
 * Owner names from snippets that are about THIS store (link on its domain, or
 * the snippet names the store), minus names tied to a different business.
 */
export function ownersFromHits(
  hits: SearchHit[],
  store: string,
  domain: string,
  firstNames: Set<string>,
): (NameHit & { url: string })[] {
  const toks = shortStore(store).map((t) => t.toLowerCase())
  if (!toks.length) toks.push(domain.split('.')[0])
  const out: (NameHit & { url: string })[] = []
  for (const h of hits) {
    const txt = `${h.title} . ${h.snippet}`
    const rel = h.link.includes(domain) || toks.some((t) => txt.toLowerCase().includes(t))
    if (!rel) continue
    for (const n of namesFromText(txt, firstNames)) {
      if (otherBusiness(n, store, domain)) continue
      out.push({ ...n, url: h.link })
    }
  }
  return out
}

/** "@domain" addresses printed in snippets (the Shopify-429 fallback), placeholders dropped. */
export function domainEmailsFromHits(hits: SearchHit[], domain: string): { email: string; url: string }[] {
  const rx = new RegExp(`[A-Za-z0-9._%+-]+@${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
  const seen = new Map<string, string>()
  for (const h of hits) {
    for (const m of `${h.title} ${h.snippet}`.matchAll(rx)) {
      const e = m[0].toLowerCase()
      if (!isPlaceholder(e, true) && !seen.has(e)) seen.set(e, h.link)
    }
  }
  return [...seen].map(([email, url]) => ({ email, url }))
}
