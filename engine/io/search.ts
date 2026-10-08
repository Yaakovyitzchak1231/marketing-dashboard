/**
 * Pluggable web search. SERPER_API_KEY (what Tab used; a paid API, about
 * $1 per 1,000 searches on its pricing page at the time, unverified here) or
 * SEARXNG_URL (free, self-hosted on the OVH box). Neither set -> null, and the
 * search-based stages are skipped with a plain note on the run.
 */
import { request } from './http.ts'
import { hitsFromSearxng, hitsFromSerper, type SearchHit } from '../parse/search.ts'

export interface SearchProvider {
  name: 'serper' | 'searxng'
  search(q: string): Promise<SearchHit[]>
}

export function searchProviderFromEnv(env: NodeJS.ProcessEnv = process.env): SearchProvider | null {
  if (env.SERPER_API_KEY) {
    const key = env.SERPER_API_KEY
    return {
      name: 'serper',
      async search(q) {
        const r = await request('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'x-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({ q, num: 10 }),
          timeoutMs: 30_000,
        })
        if (r.status !== 200) throw new Error(`search answered HTTP ${r.status}`)
        return hitsFromSerper(JSON.parse(r.body))
      },
    }
  }
  if (env.SEARXNG_URL) {
    const base = env.SEARXNG_URL.replace(/\/$/, '')
    return {
      name: 'searxng',
      async search(q) {
        const r = await request(`${base}/search?format=json&q=${encodeURIComponent(q)}`, { timeoutMs: 30_000 })
        if (r.status !== 200) throw new Error(`SearXNG answered HTTP ${r.status}`)
        return hitsFromSearxng(JSON.parse(r.body))
      },
    }
  }
  return null
}
