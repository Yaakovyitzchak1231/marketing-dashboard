/**
 * research_company: one company, researched the same way Find leads does it
 * (its website, then owner / "@domain" search when a provider is set).
 * Produces the ResearchResult contract from lib/research/types.ts.
 */
import type { ResearchResult } from '../lib/research/types.ts'
import { crawlSite, type CrawlDeps } from './crawl.ts'
import { loadFirstNames } from './data.ts'
import { mxLookup } from './io/dns.ts'
import { HostLimiter, ProxyPool } from './io/http.ts'
import type { SearchProvider } from './io/search.ts'
import { hostOf, regDomain } from './parse/domains.ts'
import { domainEmailsFromHits, ownerQuery, ownersFromHits } from './parse/search.ts'
import { toResearchResult } from './findLeads.ts'

export interface ResearchPayload {
  name: string
  website?: string | null
  city?: string | null
  state?: string | null
}

export async function researchCompany(
  companyId: number,
  payload: ResearchPayload,
  opts: { runner: string; search: SearchProvider | null; useProxies?: boolean; crawlDeps?: Partial<CrawlDeps>; mx?: (domain: string) => Promise<string[] | 'nxdomain' | 'error'> },
): Promise<ResearchResult> {
  const firstNames = loadFirstNames()
  if (!payload.website) {
    return {
      company_id: companyId, runner: opts.runner, pages_fetched: [], emails: [], people: [], phones: [], facts: [],
      summary: `${payload.name}: no website on file, nothing to read`,
    }
  }
  const proxies = ProxyPool.fromEnv()
  const deps: CrawlDeps = {
    limiter: new HostLimiter(1, 1000), proxies, useProxies: Boolean(opts.useProxies && proxies.size), firstNames, robots: new Map(),
  }
  for (const [k, v] of Object.entries(opts.crawlDeps ?? {})) if (v !== undefined) (deps as unknown as Record<string, unknown>)[k] = v
  const cr = await crawlSite(payload.website, deps)
  const domain = regDomain(hostOf(payload.website))
  const ownerSearch: { search_names?: ReturnType<typeof ownersFromHits>; search_emails?: ReturnType<typeof domainEmailsFromHits> } = {}
  if (opts.search) {
    try {
      if (!cr.owner || cr.owner.confidence !== 'high') {
        ownerSearch.search_names = ownersFromHits(await opts.search.search(ownerQuery(payload.name, payload.city ?? null, payload.state ?? null)), payload.name, domain, firstNames)
      }
      if (cr.blocked || !cr.emails.length) ownerSearch.search_emails = domainEmailsFromHits(await opts.search.search(`"@${domain}"`), domain)
    } catch {
      /* search is best-effort; the website evidence still counts */
    }
  }
  const mxr = await (opts.mx ?? mxLookup)(domain)
  const mx = mxr === 'error' ? null : mxr === 'nxdomain' ? 'domain does not exist' : mxr.length ? 'ok' : 'no mail server'
  const slim = { ...cr, names: cr.names.map((n) => ({ ...n, ctx: n.ctx.slice(0, 200) })) }
  return toResearchResult(companyId, opts.runner, slim, ownerSearch, domain, mx)
}
