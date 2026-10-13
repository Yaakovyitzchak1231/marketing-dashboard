import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { createTestDb } from './helpers/pglite-db'
import { fakeWeb, healthySite, page, WALL } from './helpers/seo-fake-web'
import {
  addCompetitor, addPrompt, addSite, getFixTask, latestAudits, latestRuns, listFixTasks, listSites, normalizeBaseUrl, parsePaths, runSiteAudit, runVisibility, runResults,
} from '@/lib/seo/store'
import { applyChange, listChanges, previewChange, undoChange, validateJsonLd } from '@/lib/seo/changes'
import { WpClient, type WpFetch } from '@/lib/seo/wordpress'
import { analyzeAnswer, tallyResults } from '@/lib/seo/visibility'
import { gscReport, signJwt } from '@/lib/seo/searchconsole'
import { claimTask } from '@/lib/ops/core'

type Db = Awaited<ReturnType<typeof createTestDb>>
let db: Db

beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})

/** A fake WordPress REST API: pages by id with status + meta; records every write. */
function fakeWp(opts: { snippet: boolean }) {
  const meta = (o: Record<string, string> = {}) =>
    opts.snippet ? { _yoast_wpseo_title: '', _yoast_wpseo_metadesc: '', _yoast_wpseo_canonical: '', '_yoast_wpseo_meta-robots-noindex': '', _tapdash_jsonld: '', ...o } : {}
  const pages = new Map<number, { id: number; slug: string; link: string; status: string; title: { raw: string }; content?: { raw: string }; meta: Record<string, string> }>([
    [10, { id: 10, slug: 'home', link: 'https://gempay.test/', status: 'publish', title: { raw: 'Home New' }, meta: meta() }],
    [11, { id: 11, slug: 'partners', link: 'https://gempay.test/partners/', status: 'publish', title: { raw: 'Partners' }, meta: meta({ _yoast_wpseo_canonical: 'https://www.gempay.test/partners/' }) }],
    [12, { id: 12, slug: 'test-inner-page-2', link: 'https://gempay.test/test-inner-page-2/', status: 'publish', title: { raw: 'Test' }, meta: meta() }],
  ])
  let nextId = 100
  const writes: { method: string; url: string; body: unknown; auth: string | undefined }[] = []
  const fetcher: WpFetch = async (url, init) => {
    const u = new URL(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    if (method !== 'GET') writes.push({ method, url, body, auth: init?.headers?.Authorization })
    const ok = (j: unknown, status = 200) => ({ status, text: async () => JSON.stringify(j) })
    if (init?.headers?.Authorization !== `Basic ${Buffer.from('jacob:abcdefgh').toString('base64')}`)
      return ok({ code: 'rest_not_logged_in', message: 'You are not currently logged in.' }, 401)
    const p = u.pathname.replace('/wp-json', '')
    if (p === '/wp/v2/settings') return ok({ page_on_front: 10 })
    if (p === '/wp/v2/pages' && method === 'GET') return ok([...pages.values()].filter((x) => x.slug === u.searchParams.get('slug')))
    if (p === '/wp/v2/posts' && method === 'GET') return ok([])
    if (p === '/wp/v2/pages' && method === 'POST') {
      const id = nextId++
      const np = { id, slug: body.slug, link: `https://gempay.test/?page_id=${id}`, status: 'draft', title: { raw: body.title }, content: { raw: body.content ?? '' }, meta: meta() }
      pages.set(id, np)
      return ok(np, 201)
    }
    const m = /^\/wp\/v2\/pages\/(\d+)$/.exec(p)
    if (m) {
      const pg = pages.get(Number(m[1]))
      if (!pg) return ok({ code: 'rest_post_invalid_id', message: 'Invalid post ID.' }, 404)
      if (method === 'GET') return ok(pg)
      if (method === 'DELETE') {
        pg.status = 'trash'
        return ok(pg)
      }
      if (body.status) pg.status = body.status
      if (body.meta) {
        for (const [k, v] of Object.entries(body.meta)) {
          if (!(k in pg.meta)) return ok({ code: 'rest_invalid_param', message: `meta.${k} is not registered` }, 400)
          pg.meta[k] = String(v)
        }
      }
      return ok(pg)
    }
    return ok({ code: 'rest_no_route', message: 'No route' }, 404)
  }
  return { fetcher, pages, writes }
}
const CFG = { siteUrl: 'https://gempay.test', user: 'jacob', appPassword: 'abcd efgh' }

describe('SEO schema + seeds', () => {
  it('seeds TapDash sites, questions, competitors and the SEO project', async () => {
    const sites = await listSites(db)
    expect(sites.map((s) => s.base_url)).toEqual(['https://tapdash.co', 'https://ai-builder-pay.lovable.app'])
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from lp.seo_prompts')
    expect(rows[0].n).toBeGreaterThanOrEqual(5)
    const pr = await db.query<{ name: string }>("select name from lp.projects where name = 'SEO / AI visibility'")
    expect(pr.rows).toHaveLength(1)
  })
  it('normalizes site input', () => {
    expect(normalizeBaseUrl('TapDash.co/jewelers/')).toBe('https://tapdash.co')
    expect(() => normalizeBaseUrl('not a site')).toThrow()
    expect(parsePaths('/jewelers, pricing https://x.test/compare/ /')).toEqual(['/jewelers/', '/pricing/', '/compare/'])
  })
})

describe('audit -> fix list -> re-audit', () => {
  let siteId = 0
  it('stores the audit and creates seo_fix tasks once (deduped while open)', async () => {
    const site = await addSite(db, 'owner', { name: 'Gem Pay', base_url: 'https://gempay.test', platform: 'wordpress', host: 'siteground', campaign: 'jewelers', pages: ['/jewelers/', '/partners/'] })
    siteId = site.id
    const web = healthySite()
    const r1 = await runSiteAudit(db, 'owner', siteId, { fetcher: web.fetcher })
    expect(r1.audit.status).toBe('done')
    expect(r1.audit.passed).toBeGreaterThan(0)
    expect(r1.fixes.created).toBeGreaterThan(3)
    const r2 = await runSiteAudit(db, 'owner', siteId, { fetcher: web.fetcher })
    expect(r2.fixes.created).toBe(0)
    const open = await listFixTasks(db, { siteId, open: true })
    expect(open.length).toBe(r1.fixes.created)
    expect(open.every((t) => t.payload.site_id === siteId)).toBe(true)
    expect((await latestAudits(db)).get(siteId)?.id).toBe(r2.audit.id)
    const ev = await db.query<{ summary: string }>("select summary from lp.events where kind = 'seo.audit' order by id desc limit 1")
    expect(ev.rows[0].summary).toMatch(/^SEO audit of Gem Pay: \d+ passed, \d+ failed, \d+ to improve, \d+ couldn't be checked$/)
  })

  it('agents can claim SEO fixes through the normal task queue', async () => {
    const t = await claimTask(db, 'hermes', { kinds: ['seo_fix'] })
    expect(t?.kind).toBe('seo_fix')
    expect(t?.claimed_by).toBe('hermes')
  })

  it('a re-audit that passes a check closes its open, unclaimed fix', async () => {
    const web = healthySite()
    // Fix the H1 on the home page.
    const fixed = async (url: string, init?: { signal?: AbortSignal }) => {
      const r = await web.fetcher(url, init)
      if (url === 'https://gempay.test/') {
        const body = (await r.text()).replace('<body>', '<body><h1>Card processing for independent retailers</h1>')
        return { ...r, text: async () => body }
      }
      return r
    }
    const before = (await listFixTasks(db, { siteId, open: true })).find((f) => f.payload.fix.check_id === 'h1')
    expect(before).toBeTruthy()
    const r = await runSiteAudit(db, 'owner', siteId, { fetcher: fixed })
    expect(r.fixes.closed).toBeGreaterThanOrEqual(1)
    const after = await getFixTask(db, before!.id)
    expect(after!.claimed_by).toBeNull()
    expect(after!.status).toBe('done')
    // the task Hermes holds is never closed under him
    const held = await db.query<{ status: string }>("select status from lp.tasks where claimed_by = 'hermes'")
    expect(held.rows[0].status).toBe('claimed')
  })
})

describe('WordPress actions (mocked WP API)', () => {
  let siteId = 0
  let taskId = 0
  beforeAll(async () => {
    siteId = (await listSites(db)).find((s) => s.base_url === 'https://gempay.test')!.id
    taskId = (await listFixTasks(db, { siteId, open: true })).find((f) => f.payload.fix.check_id === 'canonical' && !f.claimed_by)?.id ?? 0
  })

  it('preview shows the live value; apply writes Yoast meta, logs it, and undo restores it', async () => {
    const wp = fakeWp({ snippet: true })
    const env = { cfg: CFG, fetcher: wp.fetcher }
    const pv = await previewChange(db, siteId, { kind: 'set_meta', field: 'canonical', path: '/partners/', value: 'https://gempay.test/partners/', expect_before: null }, env)
    expect(pv.before).toBe('https://www.gempay.test/partners/')
    expect(pv.needsSnippet).toBe(false)
    const c = await applyChange(db, 'owner', siteId, taskId || null, { kind: 'set_meta', field: 'canonical', path: '/partners/', value: 'https://gempay.test/partners/', expect_before: pv.before }, env)
    expect(wp.pages.get(11)!.meta._yoast_wpseo_canonical).toBe('https://gempay.test/partners/')
    expect(c.before).toEqual({ type: 'page', meta: { _yoast_wpseo_canonical: 'https://www.gempay.test/partners/' } })
    expect(wp.writes.every((w) => w.auth === `Basic ${Buffer.from('jacob:abcdefgh').toString('base64')}`)).toBe(true)
    if (taskId) expect((await getFixTask(db, taskId))!.status).toBe('done')
    const ev = await db.query<{ summary: string }>("select summary from lp.events where kind = 'seo.change' order by id desc limit 1")
    expect(ev.rows[0].summary).toBe(`Applied WordPress change #${c.id} on Gem Pay: page 11 /partners/`)
    const u = await undoChange(db, 'owner', c.id, env)
    expect(u.status).toBe('undone')
    expect(wp.pages.get(11)!.meta._yoast_wpseo_canonical).toBe('https://www.gempay.test/partners/')
    if (taskId) expect((await getFixTask(db, taskId))!.status).toBe('queued')
  })

  it('refuses to apply when the live value changed since the preview', async () => {
    const wp = fakeWp({ snippet: true })
    await expect(
      applyChange(db, 'owner', siteId, null, { kind: 'set_meta', field: 'title', path: '/partners/', value: 'New', expect_before: 'Something else' }, { cfg: CFG, fetcher: wp.fetcher }),
    ).rejects.toThrow(/changed since your preview/)
    expect(wp.writes).toHaveLength(0)
  })

  it('without the snippet, Yoast fields are refused but "move to draft" works (and undoes)', async () => {
    const wp = fakeWp({ snippet: false })
    const env = { cfg: CFG, fetcher: wp.fetcher }
    const pv = await previewChange(db, siteId, { kind: 'add_schema', path: '/partners/', value: '{}', expect_before: null }, env)
    expect(pv.needsSnippet).toBe(true)
    await expect(applyChange(db, 'owner', siteId, null, { kind: 'hide_page', path: '/test-inner-page-2/', mode: 'noindex' }, env)).rejects.toThrow(/snippet/)
    const c = await applyChange(db, 'owner', siteId, null, { kind: 'hide_page', path: '/test-inner-page-2/', mode: 'draft' }, env)
    expect(wp.pages.get(12)!.status).toBe('draft')
    await undoChange(db, 'owner', c.id, env)
    expect(wp.pages.get(12)!.status).toBe('publish')
  })

  it('JSON-LD must parse and have no EDIT placeholders before it can be applied', async () => {
    expect(() => validateJsonLd('{not json')).toThrow(/valid JSON/)
    expect(() => validateJsonLd('{"@type":"FAQPage","x":"EDIT: fill"}')).toThrow(/EDIT/)
    const wp = fakeWp({ snippet: true })
    const env = { cfg: CFG, fetcher: wp.fetcher }
    const v = '{"@context":"https://schema.org","@type":"Service","name":"Gem Pay"}'
    const c = await applyChange(db, 'owner', siteId, null, { kind: 'add_schema', path: '/', value: v, expect_before: null }, env)
    expect(JSON.parse(wp.pages.get(10)!.meta._tapdash_jsonld)['@type']).toBe('Service')
    expect(c.kind).toBe('add_schema')
  })

  it('creates pages only as drafts; undo trashes the draft', async () => {
    const wp = fakeWp({ snippet: false })
    const env = { cfg: CFG, fetcher: wp.fetcher }
    const c = await applyChange(db, 'owner', siteId, null, { kind: 'create_draft', title: 'Best Processing for Jewelers', slug: 'Best Processing!', content: '<p>x</p>' }, env)
    const post = wp.writes.find((w) => w.method === 'POST' && w.url.endsWith('/wp-json/wp/v2/pages'))!
    expect(post.body).toMatchObject({ status: 'draft', slug: 'best-processing' })
    await undoChange(db, 'owner', c.id, env)
    expect(wp.pages.get(c.wp_id!)!.status).toBe('trash')
    expect((await listChanges(db, { siteId })).length).toBeGreaterThanOrEqual(4)
  })

  it('a WP_SITE_URL for another site is refused before any call', async () => {
    const wp = fakeWp({ snippet: true })
    await expect(previewChange(db, siteId, { kind: 'set_meta', field: 'title', path: '/', value: 'x', expect_before: null }, { cfg: { ...CFG, siteUrl: 'https://other.test' }, fetcher: wp.fetcher })).rejects.toThrow(/not this site/)
    await expect(previewChange(db, siteId, { kind: 'set_meta', field: 'title', path: '/', value: 'x', expect_before: null }, { cfg: null })).rejects.toThrow(/not connected/)
  })

  it('a SiteGround wall in front of the REST API is reported in plain words', async () => {
    const wall: WpFetch = async () => ({ status: 202, text: async () => '<meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=x">' })
    await expect(new WpClient(CFG, wall).whoami()).rejects.toThrow(/anti-bot wall/)
  })
})

describe('AI visibility (mocked model APIs)', () => {
  it('analyzes mentions, competitors and citations', () => {
    const a = analyzeAnswer(
      { text: 'Top picks: Square, Clover, and TapDash for jewelers. Squarespace is a website builder.', citedUrls: ['https://www.tapdash.co/jewelers/', 'https://helcim.com/x'] },
      ['TapDash', 'tapdash.co'],
      [{ name: 'Square', domain: 'squareup.com' }, { name: 'Clover', domain: 'clover.com' }, { name: 'Helcim', domain: 'helcim.com' }, { name: 'Stripe', domain: 'stripe.com' }],
    )
    expect(a.mentioned).toBe(true)
    expect(a.matchedTerms.sort()).toEqual(['TapDash'])
    expect(a.competitors).toEqual(['Square', 'Clover'])
    expect(analyzeAnswer({ text: 'Use Stripe.', citedUrls: [] }, ['TapDash'], []).mentioned).toBe(false)
  })

  it('refuses to run without a key, runs every active question with one, and stores answers', async () => {
    await addPrompt(db, 'owner', 'best card processor for a jewelry store in NJ', 'jewelers')
    await addCompetitor(db, 'owner', 'Helcim', 'https://www.helcim.com/')
    await expect(runVisibility(db, 'owner', 'gemini', { env: {} })).rejects.toThrow(/GEMINI_API_KEY/)
    const calls: string[] = []
    let n = 0
    const fetcher = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push(url)
      expect(init.headers['x-goog-api-key']).toBe('test-key')
      n++
      if (n === 2) return { status: 429, text: async () => JSON.stringify({ error: { message: 'Resource exhausted' } }) }
      const text = n % 3 === 0 ? 'TapDash and Clover are good for jewelers.' : 'Square or Helcim.'
      return { status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://helcim.com/a' } }] } }] }) }
    }
    const run = await runVisibility(db, 'owner', 'gemini', { env: { GEMINI_API_KEY: 'test-key' }, fetcher })
    expect(calls.every((u) => u.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'))).toBe(true)
    const results = await runResults(db, [run.id])
    expect(results).toHaveLength(run.prompt_count!)
    expect(results.filter((r) => r.error)).toHaveLength(1)
    expect(results.find((r) => r.error)!.error).toContain('HTTP 429')
    expect(run.status).toBe('done')
    expect(run.mentioned).toBe(results.filter((r) => r.mentioned).length)
    expect(results.find((r) => r.mentioned === false)!.competitors).toContain('Helcim')
    // Accounting: attempted = answered + failed + unknown, and the config is kept.
    expect(run.attempted).toBe(run.prompt_count)
    expect(run.failed).toBe(1)
    expect(run.answered).toBe(run.prompt_count! - 1)
    expect(run.unknown).toBe(0)
    expect(run.attempted).toBe(run.answered! + run.failed! + run.unknown!)
    expect(run.web_search).toBe(false)
    expect(run.brand_terms).toContain('TapDash')
    expect(run.prompts).toHaveLength(run.prompt_count!)
    expect(run.prompts!.some((p) => p.prompt === 'best card processor for a jewelry store in NJ')).toBe(true)
    expect(tallyResults(results)).toEqual({ attempted: run.attempted, answered: run.answered, failed: run.failed, unknown: run.unknown })
  })

  it('an empty provider response stays unknown, never a "not named" negative', async () => {
    const fetcher = async () => ({ status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] } }] }) })
    const run = await runVisibility(db, 'owner', 'gemini', { env: { GEMINI_API_KEY: 'test-key' }, fetcher })
    expect(run.status).toBe('failed')
    expect(run.mentioned).toBeNull()
    expect(run.answered).toBe(0)
    expect(run.failed).toBe(0)
    expect(run.unknown).toBe(run.prompt_count)
    const rows = await runResults(db, [run.id])
    expect(rows).toHaveLength(run.prompt_count!)
    expect(rows.every((r) => r.mentioned === null)).toBe(true)
    expect(rows.every((r) => r.error === null)).toBe(true)
    expect(rows.some((r) => r.mentioned === false)).toBe(false)
    expect(tallyResults(rows)).toEqual({ attempted: run.prompt_count, answered: 0, failed: 0, unknown: run.prompt_count })
  })

  it('all failures mark the run failed and store no negatives', async () => {
    const fetcher = async () => ({ status: 500, text: async () => JSON.stringify({ error: { message: 'boom' } }) })
    const run = await runVisibility(db, 'owner', 'gemini', { env: { GEMINI_API_KEY: 'test-key' }, fetcher })
    expect(run.status).toBe('failed')
    expect(run.mentioned).toBeNull()
    expect(run.answered).toBe(0)
    expect(run.failed).toBe(run.prompt_count)
    expect(run.unknown).toBe(0)
    const rows = await runResults(db, [run.id])
    expect(rows.every((r) => r.error)).toBe(true)
    expect(rows.every((r) => r.mentioned === null)).toBe(true)
    expect(tallyResults(rows)).toEqual({ attempted: run.prompt_count, answered: 0, failed: run.prompt_count, unknown: 0 })
  })

  it('keeps web search and brand terms for the run it used them on', async () => {
    const fetcher = async () => ({ status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'No one here.' }] } }] }) })
    const run = await runVisibility(db, 'owner', 'gemini', { env: { GEMINI_API_KEY: 'test-key', SEO_WEB_SEARCH: '1' }, fetcher })
    expect(run.web_search).toBe(true)
    expect(run.brand_terms!.length).toBeGreaterThan(0)
  })

  it('falls back to the result rows when a historical run has no stored counts', async () => {
    // A run written before migration 0017: the accounting columns are null and
    // the page must read the result rows instead of showing nothing.
    const { rows: started } = await db.query<{ id: number }>(
      `insert into lp.seo_visibility_runs (provider, model, status, prompt_count, mentioned, finished_at) values ('gemini', 'gemini-2.5-flash', 'done', 3, 1, now()) returning id`,
    )
    const runId = started[0].id
    await db.query(
      `insert into lp.seo_visibility_results (run_id, prompt, answer, mentioned) values ($1, 'q1', 'TapDash', true), ($1, 'q2', 'Square', false), ($1, 'q3', null, null)`,
      [runId],
    )
    const run = (await latestRuns(db)).find((r) => r.id === runId)!
    expect(run.attempted).toBeNull()
    expect(run.answered).toBeNull()
    expect(run.unknown).toBeNull()
    const rows = await runResults(db, [runId])
    expect(tallyResults(rows)).toEqual({ attempted: 3, answered: 2, failed: 0, unknown: 1 })
  })

  it('OpenAI / Anthropic / Perplexity answers parse from their shapes', async () => {
    const { ask } = await import('@/lib/seo/visibility')
    const mk = (j: unknown) => async () => ({ status: 200, text: async () => JSON.stringify(j) })
    expect(await ask('openai', 'k', 'm', 'q', { fetcher: mk({ output: [{ type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: 'Hi TapDash', annotations: [{ type: 'url_citation', url: 'https://a.test' }] }] }] }) })).toEqual({ text: 'Hi TapDash', citedUrls: ['https://a.test/'], retrievedUrls: [] })
    expect(await ask('anthropic', 'k', 'm', 'q', { fetcher: mk({ content: [{ type: 'text', text: 'A', citations: [{ url: 'https://b.test' }] }, { type: 'text', text: 'B' }] }) })).toEqual({ text: 'AB', citedUrls: ['https://b.test/'], retrievedUrls: [] })
    expect(await ask('perplexity', 'k', 'sonar', 'q', { fetcher: mk({ choices: [{ message: { content: 'P' } }], citations: ['https://c.test'] }) })).toEqual({ text: 'P', citedUrls: ['https://c.test/'], retrievedUrls: [] })
  })
})

describe('Search Console (mocked Google)', () => {
  it('signs a service-account JWT and reads queries + pages', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const cfg = { clientEmail: 'sa@p.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), siteUrl: 'sc-domain:gempay.test' }
    const jwt = signJwt(cfg, 1_800_000_000)
    const [h, c, sig] = jwt.split('.')
    const v = createVerify('RSA-SHA256')
    v.update(`${h}.${c}`)
    expect(v.verify(publicKey, new Uint8Array(Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')))).toBe(true)
    expect(JSON.parse(Buffer.from(c, 'base64').toString()).scope).toBe('https://www.googleapis.com/auth/webmasters.readonly')
    const fetcher = async (url: string, init: { body?: string; headers: Record<string, string> }) => {
      if (url.startsWith('https://oauth2.googleapis.com/token')) return { status: 200, text: async () => JSON.stringify({ access_token: 'tok' }) }
      expect(url).toContain(encodeURIComponent('sc-domain:gempay.test'))
      expect(init.headers.Authorization).toBe('Bearer tok')
      const dim = JSON.parse(init.body!).dimensions[0]
      return { status: 200, text: async () => JSON.stringify({ rows: [{ keys: [dim === 'query' ? 'jewelry card processing' : 'https://gempay.test/jewelers/'], clicks: 3, impressions: 120, ctr: 0.025, position: 14.2 }] }) }
    }
    const r = await gscReport(cfg, { fetcher, now: new Date('2026-10-08T12:00:00Z') })
    expect(r.endDate).toBe('2026-10-05')
    expect(r.startDate).toBe('2026-09-08')
    expect(r.queries[0]).toEqual({ key: 'jewelry card processing', clicks: 3, impressions: 120, ctr: 0.025, position: 14.2 })
    expect(r.pages[0].key).toBe('https://gempay.test/jewelers/')
  })
})

describe('a blocked re-audit retires a fix it can no longer confirm', () => {
  it('a "No sitemap" fix from a misread run is cancelled once the sitemap is seen as bot blocked', async () => {
    const site = await addSite(db, 'owner', { name: 'Blocky', base_url: 'https://blocky.test', platform: 'wordpress', host: 'siteground', campaign: null, pages: [] })
    const home = { body: page({ title: 'Blocky card processing', description: 'For shops.', canonical: 'https://blocky.test/', h1: ['Blocky'] }) }
    const robots = { body: 'User-agent: *\nDisallow:\n', type: 'text/plain' }
    // Run 1: every sitemap URL answers 404 -> a real "No XML sitemap found" fix.
    const r1 = await runSiteAudit(db, 'owner', site.id, { fetcher: fakeWeb({ 'https://blocky.test/robots.txt': robots, 'https://blocky.test/': home }).fetcher })
    expect(r1.audit.checks.find((c) => c.id === 'sitemap')?.status).toBe('fail')
    const fix = (await listFixTasks(db, { siteId: site.id, open: true })).find((f) => f.payload.fix.check_id === 'sitemap')
    expect(fix).toBeTruthy()
    // Run 2: the sitemap is behind SiteGround's captcha -> blocked, and the old fix leaves the list.
    const SG = { status: 202, body: WALL }
    const r2 = await runSiteAudit(db, 'owner', site.id, {
      fetcher: fakeWeb({ 'https://blocky.test/robots.txt': robots, 'https://blocky.test/': home, 'https://blocky.test/sitemap_index.xml': SG, 'https://blocky.test/sitemap.xml': SG, 'https://blocky.test/wp-sitemap.xml': SG }).fetcher,
    })
    expect(r2.audit.checks.find((c) => c.id === 'sitemap')?.status).toBe('blocked')
    expect(r2.audit.unknown).toBeGreaterThanOrEqual(1)
    expect((await getFixTask(db, fix!.id))?.status).toBe('cancelled')
    const c = await db.query<{ body: string }>('select body from lp.comments where task_id = $1 order by id desc limit 1', [fix!.id])
    expect(c.rows[0].body).toContain('Blocked: SiteGround captcha (HTTP 202)')
    const ev = await db.query<{ summary: string }>("select summary from lp.events where kind = 'seo.audit' order by id desc limit 1")
    expect(ev.rows[0].summary).toContain('blocked from our checker')
  })
})
