/**
 * One "Find leads" job, end to end: discover -> filter -> crawl -> owner ->
 * build. Tab's Oct 6 pipeline (tapdash_scraper/scraper.py + enrich.py) as a
 * resumable engine: every search and every business is a checkpoint row, the
 * task's lease is renewed as it goes, and a cancel from the dashboard stops it
 * at the next item.
 */
import { readFileSync } from 'node:fs'
import type { Db } from '../lib/db/types.ts'
import { normalizePhone } from '../lib/leads/normalize.ts'
import { logEvent } from '../lib/ops/events.ts'
import { applyResearchResult } from '../lib/research/apply.ts'
import { upsertCompany } from '../lib/research/companies.ts'
import type { ResearchResult } from '../lib/research/types.ts'
import { crawlSite, type CrawlDeps, type CrawlResult } from './crawl.ts'
import { loadCities, loadFirstNames, loadPbTemplate } from './data.ts'
import { mxLookup } from './io/dns.ts'
import { backoffMs, HostLimiter, ProxyPool, request, sleep, type HttpResponse } from './io/http.ts'
import type { SearchProvider } from './io/search.ts'
import { hostOf, phone10, STATE_ABBR } from './parse/domains.ts'
import { chooseOwner } from './parse/extract.ts'
import { classifyPlace, DROP_REASON_WORDS } from './parse/filter.ts'
import { isBlocked, mapsSearchUrl, parseMapsBody, parsePlaces, placeKey, type MapsPlace } from './parse/maps.ts'
import { domainEmailsFromHits, ownerQuery, ownersFromHits } from './parse/search.ts'
import { describeGeography, OWNER_EXTRA_STAGES, type FindLeadsParams } from './params.ts'
import { mergeOwner } from './parse/owners.ts'
import { runOwnerExtras, type OwnerExtras } from './ownerStages.ts'
import {
  addNote, computeCounters, finishRun, insertPlace, insertSearches, openRun, pendingItems, saveCounters, setStage, updateItem,
  type EngineItem, type RunCounters,
} from './store.ts'

export interface TaskControl {
  /** Renew the lease and publish progress. 'cancelled' when the task was cancelled from the dashboard. */
  heartbeat(progress: unknown, note?: string): Promise<'ok' | 'cancelled'>
}

export interface FindLeadsDeps {
  agent: string
  control: TaskControl
  search: SearchProvider | null
  proxies?: ProxyPool
  /** Overridable network for tests. */
  fetch?: (url: string, o?: Parameters<typeof request>[1]) => Promise<HttpResponse>
  mx?: (domain: string) => Promise<string[] | 'nxdomain' | 'error'>
  log?: (line: string) => void
  /** Minimum gap between heartbeats (default 5 s). */
  heartbeatEveryMs?: number
  /** Crawl politeness overrides (tests): per-host gap, 429 retry wait, backoff base. */
  politeness?: { gapMs?: number; retry429Ms?: number; backoffBaseMs?: number }
}

export interface FindLeadsOutcome {
  status: 'done' | 'cancelled' | 'failed'
  run_id: number
  counters: RunCounters
  report: string
}

class Cancelled extends Error {}

function planSearches(p: FindLeadsParams): { searches: { key: string; data: Record<string, unknown> }[]; unknownCities: string[] } {
  const all = loadCities(STATE_ABBR)
  let picked = all
  const unknownCities: string[] = []
  if (!p.geography.all_us) {
    const states = new Set(p.geography.states)
    const wanted = p.geography.cities.map((c) => {
      const [city, st] = c.split(',').map((s) => s.trim())
      return { city: city.toLowerCase(), st: st.toUpperCase(), raw: c }
    })
    picked = all.filter((c) => states.has(c.state) || wanted.some((w) => w.city === c.city.toLowerCase() && w.st === c.state))
    for (const w of wanted) if (!all.some((c) => c.city.toLowerCase() === w.city && c.state === w.st)) unknownCities.push(w.raw)
  }
  const searches: { key: string; data: Record<string, unknown> }[] = []
  for (const c of picked) {
    const offsets = [0, ...(c.population >= 250_000 ? [20] : []), ...(c.population >= 900_000 ? [40] : [])]
    for (const q of p.queries) for (const o of offsets) {
      searches.push({ key: `${c.city}|${c.state}|${q}|${o}`, data: { city: c.city, state: c.state, lat: c.lat, lng: c.lng, query: q, offset: o } })
    }
  }
  return { searches, unknownCities }
}

/** Rows of a CSV or JSONL file as Maps-shaped places (name, website, phone, address, city, state, categories). */
export function placesFromFile(text: string): MapsPlace[] {
  const trimmed = text.trim()
  const rows: Record<string, string>[] = []
  if (trimmed.startsWith('{')) {
    for (const l of trimmed.split(/\r?\n/)) if (l.trim()) rows.push(JSON.parse(l))
  } else {
    const lines = trimmed.split(/\r?\n/)
    const split = (l: string) => {
      const out: string[] = []
      let cur = ''
      let qd = false
      for (let i = 0; i < l.length; i++) {
        const ch = l[i]
        if (ch === '"') {
          if (qd && l[i + 1] === '"') {
            cur += '"'
            i++
          } else qd = !qd
        } else if (ch === ',' && !qd) {
          out.push(cur)
          cur = ''
        } else cur += ch
      }
      out.push(cur)
      return out
    }
    const head = split(lines[0]).map((h) => h.trim().toLowerCase())
    for (const l of lines.slice(1)) {
      const v = split(l)
      rows.push(Object.fromEntries(head.map((h, i) => [h, (v[i] ?? '').trim()])))
    }
  }
  return rows
    .filter((r) => r.name || r.company_name)
    .map((r) => ({
      name: String(r.name || r.company_name),
      website: r.website || r.url || null,
      phone: r.phone || null,
      address: r.address || r.address_line || null,
      categories: String(r.categories || r.category || '').split(/[;|]/).map((s) => s.trim()).filter(Boolean),
      lat: null, lng: null,
      city: r.city || null,
      state: r.state || null,
      rating: null, reviews: null,
      place_id: r.place_id || r.id || null,
      cid: null,
    }))
}

export async function runFindLeads(db: Db, taskId: number, params: FindLeadsParams, deps: FindLeadsDeps): Promise<FindLeadsOutcome> {
  const fetcher = deps.fetch ?? request
  const proxies = deps.proxies ?? ProxyPool.fromEnv()
  const useProxies = params.proxies && proxies.size > 0
  const { run, resumed } = await openRun(db, taskId, params, deps.agent)
  const p = run.params // the params the run started with win on resume
  const label = `Find leads #${taskId}`
  const where = describeGeography(p)
  let lastBeat = 0

  const beat = async (force = false, note?: string) => {
    if (!force && Date.now() - lastBeat < (deps.heartbeatEveryMs ?? 5000)) return
    lastBeat = Date.now()
    const c = await saveCounters(db, run.id)
    const r = await deps.control.heartbeat({ run_id: run.id, ...c }, note)
    if (r === 'cancelled') throw new Cancelled('cancelled')
  }

  try {
    if (resumed) await logEvent(db, { actor: deps.agent, kind: 'engine.resumed', summary: `${label}: picked up where it stopped`, entity_type: 'task', entity_id: taskId, task_id: taskId })
    if (!resumed) await addNote(db, run.id, `Search config: ${p.config_source}${p.campaign_id ? ` (campaign ${p.campaign_id})` : ''} — ${p.search_phrases.length} search phrase(s), ${p.place_categories.length} category(ies), ${p.negative_keywords.length} negative keyword(s).`)
    if (params.proxies && !proxies.size) await addNote(db, run.id, 'Proxies were requested but ENGINE_PROXIES is not set on the runner, so requests go direct.')
    if (useProxies) await addNote(db, run.id, `Rotating through ${proxies.size} prox${proxies.size === 1 ? 'y' : 'ies'}.`)

    // ------------------------------------------------------------- discover
    await setStage(db, run.id, 'discover')
    const firstNames = loadFirstNames()
    const keptNow = async () => (await computeCounters(db, run.id)).kept
    const placeIn = async (pl: MapsPlace & { metro?: string | null }, meta: Record<string, unknown>, trustCategories: boolean): Promise<void> => {
      const key = placeKey(pl)
      const cls = classifyPlace(pl, p.segment, { requireCategory: !trustCategories, config: { place_categories: p.place_categories, negative_keywords: p.negative_keywords } })
      const data: Record<string, unknown> = { place: pl, found_by: meta }
      if (!cls.keep) {
        await insertPlace(db, run.id, key, 'dropped', data, cls.reason)
        return
      }
      const e164 = normalizePhone(pl.phone)
      Object.assign(data, { domain: cls.domain, city: cls.city, state: cls.state, phone_e164: e164 })
      const drop = async (reason: string) => insertPlace(db, run.id, key, 'dropped', data, reason)
      const sameDomain = await db.query<{ n: number }>(
        `select count(*)::int as n from lp.engine_items where run_id = $1 and kind = 'place' and data->>'domain' = $2`,
        [run.id, cls.domain],
      )
      if (sameDomain.rows[0].n >= 5) return void (await drop('multi_location_6plus'))
      const existing = await db.query<{ id: number }>(
        `select id from lp.companies where website_domain = $1 or ($2::text is not null and phone_e164 = $2) limit 1`,
        [cls.domain, e164],
      )
      if (existing.rows.length) {
        data.existing_company_id = existing.rows[0].id
        return void (await drop('already_in_leads'))
      }
      const dup = await db.query(
        `select 1 from lp.engine_items where run_id = $1 and kind = 'place' and status <> 'dropped'
           and (data->>'domain' = $2 or ($3::text is not null and data->>'phone_e164' = $3)) limit 1`,
        [run.id, cls.domain, e164],
      )
      if (dup.rows.length) return void (await drop('dup_in_this_job'))
      if ((await keptNow()) >= p.max_businesses) return void (await drop('over_max'))
      await insertPlace(db, run.id, key, 'pending', data, null)
    }

    if (p.source === 'file') {
      const fileKey = `file:${p.file_path}`
      await insertSearches(db, run.id, [{ key: fileKey, data: { file: p.file_path } }])
      const [item] = await pendingItems(db, run.id, 'search', 'queued', 1)
      if (item) {
        const places = placesFromFile(readFileSync(String(p.file_path), 'utf8'))
        for (const pl of places) {
          if ((await keptNow()) >= p.max_businesses) break
          await placeIn(pl, { file: p.file_path }, true)
          await beat()
        }
        await updateItem(db, item.id, { stage: 'searched', status: 'done', data: { places: places.length } })
      }
    } else {
      const { searches, unknownCities } = planSearches(p)
      if (unknownCities.length) await addNote(db, run.id, `Not in the top-1000 US cities list, so not searched: ${unknownCities.join(', ')}. Add the state instead.`)
      if (!resumed) await insertSearches(db, run.id, searches)
      const tpl = loadPbTemplate()
      let ok = 0
      let errs = 0
      let stopped = false
      while (!stopped && (await keptNow()) < p.max_businesses) {
        const batch = await pendingItems(db, run.id, 'search', 'queued', p.concurrency.maps)
        if (!batch.length) break
        const results = await Promise.all(
          batch.map(async (it) => {
            const d = it.data as { city: string; state: string; lat: number; lng: number; query: string; offset: number }
            const qq = `${d.query} ${d.city} ${d.state}`
            const proxy = useProxies ? proxies.next() : null
            try {
              await sleep(100 + Math.random() * 300)
              const r = await fetcher(mapsSearchUrl(tpl, qq, d.lat, d.lng, d.offset), { timeoutMs: 30_000, proxy, maxBytes: 5_000_000 })
              proxies.report(proxy, !isBlocked(r.status, r.url))
              if (isBlocked(r.status, r.url)) return { it, d, error: `blocked by Google (HTTP ${r.status})`, blocked: true as const }
              return { it, d, places: parsePlaces(parseMapsBody(r.body)) }
            } catch (e) {
              proxies.report(proxy, false)
              return { it, d, error: (e as Error).message.slice(0, 300) }
            }
          }),
        )
        for (const res of results) {
          if ('places' in res && res.places) {
            ok++
            for (const pl of res.places) await placeIn({ ...pl, metro: `${res.d.city}, ${res.d.state}` }, { query: res.d.query, metro: `${res.d.city}, ${res.d.state}`, offset: res.d.offset }, false)
            await updateItem(db, res.it.id, { stage: 'searched', status: 'done', data: { places: res.places.length }, error: null, attempt: true })
          } else {
            errs++
            const failedNow = res.it.attempts + 1 >= 3
            await updateItem(db, res.it.id, { status: failedNow ? 'failed' : 'pending', error: res.error ?? 'unknown error', attempt: true })
            if ('blocked' in res && res.blocked) await sleep(Math.min(60_000, 20_000 * (res.it.attempts + 1)))
          }
        }
        if (errs > 60 && errs > ok) {
          stopped = true
          await addNote(db, run.id, `Discovery stopped early: Google refused ${errs} searches (${ok} worked). Try again later or turn on proxies.`)
        }
        await beat()
      }
    }
    let c = await saveCounters(db, run.id)
    await logEvent(db, {
      actor: deps.agent,
      kind: 'engine.discovered',
      summary: `${label}: ${c.places_seen} businesses found in ${where}, ${c.kept} independents kept`,
      entity_type: 'task', entity_id: taskId, task_id: taskId,
      data: { dropped: Object.fromEntries(Object.entries(c.dropped).map(([k, v]) => [DROP_REASON_WORDS[k] ?? k, v])) },
    })

    // ---------------------------------------------------------------- crawl
    const crawlDeps: CrawlDeps = {
      limiter: new HostLimiter(1, deps.politeness?.gapMs ?? 1000), proxies, useProxies, firstNames, robots: new Map(),
      fetchPage: deps.fetch, retry429Ms: deps.politeness?.retry429Ms, backoffBaseMs: deps.politeness?.backoffBaseMs,
    }
    if (p.stages.includes('crawl')) {
      await setStage(db, run.id, 'crawl')
      for (;;) {
        const batch = await pendingItems(db, run.id, 'place', 'kept', p.concurrency.crawl * 2, 2)
        if (!batch.length) break
        let i = 0
        let cancelled: unknown = null
        await Promise.all(
          Array.from({ length: Math.min(p.concurrency.crawl, batch.length) }, async () => {
            while (i < batch.length && !cancelled) {
              const it = batch[i++]
              const place = (it.data.place ?? {}) as MapsPlace
              try {
                const cr = await withDeadline(crawlSite(String(place.website), crawlDeps), 90_000)
                await updateItem(db, it.id, { stage: 'crawled', data: { crawl: slimCrawl(cr) }, error: cr.site_ok ? null : (cr.pages.at(-1)?.error ?? 'site unreachable'), attempt: true })
              } catch (e) {
                const last = it.attempts + 1 >= 2
                await updateItem(db, it.id, { ...(last ? { stage: 'crawled', data: { crawl: null } } : {}), error: (e as Error).message.slice(0, 300), attempt: true })
              }
              try {
                await beat()
              } catch (e) {
                // stop every lane, not just this one, before the run is marked cancelled/failed
                cancelled = cancelled ?? e
              }
            }
          }),
        )
        if (cancelled) throw cancelled
      }
      c = await saveCounters(db, run.id)
      await logEvent(db, { actor: deps.agent, kind: 'engine.crawled', summary: `${label}: read ${c.crawled} store websites (${c.sites_ok} reachable)`, entity_type: 'task', entity_id: taskId, task_id: taskId })
    } else {
      await db.query(`update lp.engine_items set stage = 'crawled' where run_id = $1 and kind = 'place' and stage = 'kept' and status = 'pending'`, [run.id])
    }

    // ---------------------------------------------------------------- owner
    if (p.stages.includes('owner') && deps.search) {
      await setStage(db, run.id, 'owner')
      for (;;) {
        const batch = await pendingItems(db, run.id, 'place', 'crawled', 20, 4)
        if (!batch.length) break
        for (const it of batch) {
          const place = (it.data.place ?? {}) as MapsPlace
          const crawl = (it.data.crawl ?? null) as SlimCrawl | null
          const domain = String(it.data.domain ?? '')
          const out: Record<string, unknown> = {}
          try {
            if (!crawl?.owner || crawl.owner.confidence !== 'high') {
              const hits = await deps.search.search(ownerQuery(place.name, String(it.data.city ?? ''), String(it.data.state ?? '')))
              out.search_names = ownersFromHits(hits, place.name, domain, firstNames).slice(0, 10)
            }
            if (!crawl || crawl.blocked || !crawl.emails.length) {
              const hits = await deps.search.search(`"@${domain}"`)
              out.search_emails = domainEmailsFromHits(hits, domain).slice(0, 10)
            }
            await updateItem(db, it.id, { stage: 'owner', data: { owner_search: out }, attempt: true })
          } catch (e) {
            const last = it.attempts + 1 >= 3
            await updateItem(db, it.id, { ...(last ? { stage: 'owner' } : {}), error: `owner search: ${(e as Error).message.slice(0, 200)}`, attempt: true })
            await sleep(backoffMs(it.attempts))
          }
          await beat()
        }
      }
    } else {
      if (p.stages.includes('owner')) await addNote(db, run.id, 'Owner search skipped: no search provider is set on the runner (SERPER_API_KEY or SEARXNG_URL). Owner names come from the store websites only.')
      await db.query(`update lp.engine_items set stage = 'owner' where run_id = $1 and kind = 'place' and stage = 'crawled' and status = 'pending'`, [run.id])
    }

    // ---------------------------------------------------------------- extra owner sources (opt-in)
    const extras = OWNER_EXTRA_STAGES.filter((s) => p.stages.includes(s))
    if (extras.length) {
      await runOwnerExtras(db, run.id, extras, { agent: deps.agent, search: deps.search, fetch: deps.fetch, beat: () => beat() }, firstNames)
      c = await saveCounters(db, run.id)
      await logEvent(db, { actor: deps.agent, kind: 'engine.owner_extras', summary: `${label}: extra owner sources (${extras.join(', ')}) checked for ${c.extras_checked ?? 0} stores: ${c.extra_names ?? 0} names, ${c.facebook_emails ?? 0} Facebook emails, ${c.pattern_guesses ?? 0} pattern guesses held for verification`, entity_type: 'task', entity_id: taskId, task_id: taskId })
    } else {
      await db.query(`update lp.engine_items set stage = 'extras' where run_id = $1 and kind = 'place' and stage = 'owner' and status = 'pending'`, [run.id])
    }

    // ---------------------------------------------------------------- build
    if (p.stages.includes('build')) {
      await setStage(db, run.id, 'build')
      for (;;) {
        // extras failures share the attempts counter, so the build allows more when extra stages ran
        const batch = await pendingItems(db, run.id, 'place', 'extras', 25, extras.length ? 6 : 3)
        if (!batch.length) break
        for (const it of batch) {
          try {
            await buildOne(db, taskId, it, p, deps, firstNames)
          } catch (e) {
            await updateItem(db, it.id, { status: it.attempts + 1 >= 3 ? 'failed' : 'pending', error: `saving: ${(e as Error).message.slice(0, 300)}`, attempt: true })
          }
          await beat()
        }
      }
    } else {
      await addNote(db, run.id, 'Build stage was off: businesses were found and researched but not added to Leads.')
    }

    c = await saveCounters(db, run.id)
    await finishRun(db, run.id, 'done')
    const report = `${label} finished: ${c.places_seen} businesses found in ${where}, ${c.kept} independents kept, ${c.sites_ok} websites read, ${c.companies_new} new companies and ${c.emails_new} new emails added to Leads, ${c.owners_found} owner names.`
    await logEvent(db, { actor: deps.agent, kind: 'engine.done', summary: report, entity_type: 'task', entity_id: taskId, task_id: taskId, data: c })
    return { status: 'done', run_id: run.id, counters: c, report }
  } catch (e) {
    const c = await saveCounters(db, run.id).catch(() => null)
    if (e instanceof Cancelled) {
      await finishRun(db, run.id, 'cancelled')
      const cc = c ?? (await computeCounters(db, run.id))
      const report = `${label} was cancelled. Kept what it had: ${cc.companies_new} companies and ${cc.emails_new} emails added to Leads.`
      await logEvent(db, { actor: deps.agent, kind: 'engine.cancelled', summary: report, entity_type: 'task', entity_id: taskId, task_id: taskId })
      return { status: 'cancelled', run_id: run.id, counters: cc, report }
    }
    const msg = (e as Error).message.slice(0, 500)
    await finishRun(db, run.id, 'failed', msg)
    throw e
  }
}

interface SlimCrawl {
  site_ok: boolean
  blocked: boolean
  final_url: string | null
  pages: CrawlResult['pages']
  emails: CrawlResult['emails']
  offsite_emails: string[]
  names: { name: string; how: string; url: string; ctx: string }[]
  owner: CrawlResult['owner']
  phones: CrawlResult['phones']
  signals: CrawlResult['signals']
}

function slimCrawl(c: CrawlResult): SlimCrawl {
  return {
    site_ok: c.site_ok, blocked: c.blocked, final_url: c.final_url, pages: c.pages, emails: c.emails.slice(0, 20),
    offsite_emails: c.offsite_emails.slice(0, 10), names: c.names.slice(0, 20).map((n) => ({ ...n, ctx: n.ctx.slice(0, 200) })),
    owner: c.owner, phones: c.phones.slice(0, 5), signals: c.signals,
  }
}

function withDeadline<T>(pr: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`gave up after ${Math.round(ms / 1000)} s`)), ms)
    pr.then((v) => {
      clearTimeout(t)
      resolve(v)
    }, (e) => {
      clearTimeout(t)
      reject(e)
    })
  })
}

/** Crawl + search evidence for one item -> a ResearchResult (shared with research_company). */
export function toResearchResult(
  companyId: number,
  runner: string,
  crawl: SlimCrawl | null,
  ownerSearch: { search_names?: { name: string; how: string; url: string; ctx: string }[]; search_emails?: { email: string; url: string }[] } | null,
  domain: string,
  mx: string | null,
  extras: OwnerExtras | null = null,
): ResearchResult {
  const names = [...(crawl?.names ?? []), ...(ownerSearch?.search_names ?? []).map((n) => ({ ...n, how: 'search_owner' }))]
  const emails = crawl?.emails ?? []
  const chosen = chooseOwner(names as Parameters<typeof chooseOwner>[0], emails.map((e) => e.email))
  const merged = extras ? mergeOwner(chosen, { review: extras.review ?? null, yelp: extras.yelp ?? [] }) : chosen
  // The last name from the firstlast search rides as its own fact with its own evidence; the owner's name gains it.
  const lastName = extras?.last && merged && !merged.name.includes(' ') ? extras.last : null
  const owner = merged ? { ...merged, name: lastName ? `${merged.name} ${lastName.last}` : merged.name } : null
  const ownerFirst = owner?.name.split(' ')[0] ?? null
  const ownerLast = owner && owner.name.includes(' ') ? owner.name.split(' ').slice(-1)[0] : null
  const fbEmails = (extras?.facebook?.page ? extras.facebook.emails : []).filter((e) => !emails.some((x) => x.email === e))
  const guess = extras?.pattern && !emails.some((x) => x.email === extras.pattern!.email) ? extras.pattern : null
  const result: ResearchResult = {
    company_id: companyId,
    runner,
    pages_fetched: (crawl?.pages ?? []).map((pg) => ({ url: pg.url, status: pg.status, ...(pg.error ? { error: pg.error } : {}) })),
    emails: [
      ...emails.map((e) => ({ email: e.email, evidence_url: e.evidence_url, how: e.how })),
      ...(ownerSearch?.search_emails ?? []).filter((e) => !emails.some((x) => x.email === e.email)).map((e) => ({ email: e.email, evidence_url: e.url, how: 'search' })),
      ...fbEmails.map((e) => ({ email: e, evidence_url: extras!.facebook!.page!, how: 'facebook' })),
      // A pattern guess is never sendable before verification: guessed=true -> status 'guessed-hold', medium confidence.
      ...(guess
        ? [{
            email: guess.email,
            evidence_url: guess.evidence_url,
            how: guess.same_person ? 'published' : `pattern:${guess.pattern}`,
            first_name: ownerFirst,
            last_name: ownerLast,
            title: 'owner',
            guessed: !guess.same_person,
          }]
        : []),
    ],
    people: owner ? [{ name: owner.name, role: 'owner', evidence_url: owner.evidence_url, confidence: owner.confidence, how: owner.how }] : [],
    phones: crawl?.phones ?? [],
    facts: [
      ...(crawl?.signals ?? []).map((s) => ({ field: 'tech', value: s.signal, evidence_url: s.evidence_url, confidence: 'medium' as const })),
      ...(mx ? [{ field: 'mx', value: mx, evidence_url: null, confidence: 'high' as const }] : []),
      ...(lastName ? [{ field: 'owner_last_name', value: lastName.last, evidence_url: lastName.url, confidence: 'medium' as const }] : []),
      ...(extras?.facebook?.page ? [{ field: 'facebook', value: extras.facebook.page, evidence_url: extras.facebook.page, confidence: 'medium' as const }] : []),
      ...(guess && !guess.same_person ? [{ field: 'email_pattern', value: `${guess.pattern}@ (learned from ${guess.learned_from})`, evidence_url: guess.evidence_url, confidence: 'medium' as const }] : []),
    ],
    summary: '',
  }
  result.summary = `${domain}: ${result.emails.length} email${result.emails.length === 1 ? '' : 's'}${owner ? `, owner ${owner.name}` : ''}${crawl && !crawl.site_ok ? ', site unreachable' : ''}`
  return result
}

async function mxWord(domain: string, deps: FindLeadsDeps): Promise<string | null> {
  if (!domain) return null
  const r = await (deps.mx ?? mxLookup)(domain)
  if (r === 'error') return null
  if (r === 'nxdomain') return 'domain does not exist'
  return r.length ? 'ok' : 'no mail server'
}

async function buildOne(db: Db, taskId: number, it: EngineItem, p: FindLeadsParams, deps: FindLeadsDeps, _firstNames: Set<string>): Promise<void> {
  const place = (it.data.place ?? {}) as MapsPlace
  const crawl = (it.data.crawl ?? null) as SlimCrawl | null
  const domain = String(it.data.domain ?? '')
  const ref = `find_leads:${taskId}`
  const { id: companyId, created } = await db.tx(async (q) => {
    const up = await upsertCompany(
      q,
      {
        name: place.name,
        segment: p.segment,
        vertical: p.segment === 'jeweler' ? 'jewelry' : p.segment === 'ai_agency' ? 'ai_agency' : p.segment.replace(/_/g, ' '),
        website: crawl?.final_url && hostOf(crawl.final_url).endsWith(domain) ? crawl.final_url : place.website,
        phone: phone10(place.phone) ? place.phone : null,
        address_line: place.address,
        city: (it.data.city as string | null) ?? place.city,
        state: (it.data.state as string | null) ?? place.state,
      },
      deps.agent,
    )
    await q.query(
      `insert into lp.sources (company_id, kind, source_ref, url, payload) values ($1, $2, $3, $4, $5)
       on conflict (coalesce(company_id, 0), coalesce(contact_id, 0), kind, source_ref) do nothing`,
      [up.id, p.source === 'file' ? 'file' : 'maps', ref, place.website, JSON.stringify({ categories: place.categories, rating: place.rating, reviews: place.reviews, place_id: place.place_id, cid: place.cid, found_by: it.data.found_by })],
    )
    return up
  }, deps.agent)
  const ownerSearch = (it.data.owner_search ?? null) as Parameters<typeof toResearchResult>[3]
  const result = toResearchResult(companyId, 'engine', crawl, ownerSearch, domain, await mxWord(domain, deps), (it.data.extras ?? null) as OwnerExtras | null)
  const s = await applyResearchResult(db, result, deps.agent, { task_id: taskId, source_kind: 'engine', source_ref: ref })
  await updateItem(db, it.id, {
    stage: 'built', status: 'done', company_id: companyId, error: null,
    data: { applied: { company_created: created, contacts_created: s.contacts_created, contacts_existing: s.contacts_existing, owner: result.people[0]?.name ?? null } },
  })
}
