import { describe, expect, it } from 'vitest'
import { runAudit, summarize } from '@/lib/seo/audit'
import { buildFixes } from '@/lib/seo/fixes'
import { fakeWeb, healthySite, WALL } from './helpers/seo-fake-web'

const SITE = { base_url: 'https://gempay.test', platform: 'wordpress', host: 'siteground', pages: ['/jewelers/', '/partners/'] }

describe('runAudit', () => {
  it('audits a readable WordPress site and finds the real problems', async () => {
    const web = healthySite()
    const r = await runAudit(SITE, { fetcher: web.fetcher })
    const by = (id: string, page?: string) => r.checks.find((c) => c.id === id && (page === undefined || c.page === page))
    expect(by('bot_wall')?.status).toBe('pass')
    expect(by('robots')?.status).toBe('pass')
    expect(by('llms_txt')?.status).toBe('pass')
    expect(by('sitemap')?.status).toBe('warn')
    expect(by('sitemap')?.detail).toContain('/test-inner-page-2/')
    expect(by('h1', '/')?.status).toBe('warn')
    expect(by('canonical', '/partners/')?.status).toBe('warn')
    expect(by('canonical', '/partners/')?.detail).toContain('www.gempay.test')
    expect(by('title_generic', '/partners/')?.status).toBe('warn')
    expect(by('description_generic', '/partners/')?.status).toBe('warn')
    expect(by('schema_faq', '/jewelers/')?.status).toBe('pass')
    expect(by('schema_offer', '/jewelers/')?.status).toBe('warn')
    expect(by('schema_org')?.status).toBe('pass')
    // No PageSpeed key -> not measured, never a made-up score.
    expect(by('pagespeed')?.status).toBe('unknown')
    expect(r.pages['/jewelers/'].monthlyPrice).toBe(99)
    expect(r.sitemapUrls).toHaveLength(4)
    // No PSI call without a key
    expect(web.asked.some((u) => u.includes('pagespeedonline'))).toBe(false)
  })

  it('a bot wall makes page checks unknown and becomes the top failure', async () => {
    const web = fakeWeb({
      'https://walled.test/robots.txt': { body: 'User-agent: *\nDisallow:\n', type: 'text/plain' },
      'https://walled.test/llms.txt': { status: 202, body: WALL },
      'https://walled.test/sitemap_index.xml': { status: 202, body: WALL },
      'https://walled.test/sitemap.xml': { status: 202, body: WALL },
      'https://walled.test/wp-sitemap.xml': { status: 202, body: WALL },
      'https://walled.test/': { status: 202, body: WALL },
    })
    const r = await runAudit({ base_url: 'https://walled.test', platform: 'wordpress', host: 'siteground' }, { fetcher: web.fetcher })
    expect(r.checks[0].id).toBe('bot_wall')
    expect(r.checks[0].status).toBe('fail')
    expect(r.checks[0].fix).toContain('SiteGround')
    expect(r.checks.find((c) => c.id === 'page')?.status).toBe('unknown')
    expect(r.checks.find((c) => c.id === 'llms_txt')?.status).toBe('unknown')
    const s = summarize(r.checks)
    expect(s.failed).toBe(1)
    const fixes = buildFixes({ id: 1, name: 'W', base_url: 'https://walled.test', platform: 'wordpress', host: 'siteground', campaign: null }, r.checks, r.pages, r.sitemapUrls)
    expect(fixes[0].check_id).toBe('bot_wall')
    expect(fixes[0].action.type).toBe('manual')
    // unknowns caused by the wall don't become their own fixes
    expect(fixes.some((f) => f.check_id === 'llms_txt')).toBe(false)
  })

  it('robots.txt that blocks AI crawlers fails and names them', async () => {
    const web = fakeWeb({
      'https://b.test/robots.txt': { body: 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n', type: 'text/plain' },
      'https://b.test/': { body: '<html><head><title>B</title></head><body><h1>B</h1></body></html>' },
    })
    const r = await runAudit({ base_url: 'https://b.test' }, { fetcher: web.fetcher })
    const c = r.checks.find((x) => x.id === 'robots')!
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('GPTBot')
    expect(c.detail).toContain('ClaudeBot')
    expect(c.detail).not.toContain('PerplexityBot')
    expect(r.checks.find((x) => x.id === 'sitemap')?.status).toBe('fail')
    expect(r.checks.find((x) => x.id === 'thin')?.status).toBe('warn')
  })

  it('PageSpeed: uses the key when set and reports Google\'s score', async () => {
    const web = healthySite()
    const psi = async (url: string, init?: { signal?: AbortSignal }) => {
      if (url.includes('pagespeedonline')) {
        return { status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.42 } }, audits: { 'largest-contentful-paint': { displayValue: '5.1 s' } } } }) }
      }
      return web.fetcher(url, init)
    }
    const r = await runAudit(SITE, { fetcher: psi, pagespeedKey: 'k' })
    const c = r.checks.find((x) => x.id === 'pagespeed')!
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('42/100')
  })
})

describe('buildFixes', () => {
  it('maps findings to buttons: WordPress edits, hide pages, steps', async () => {
    const r = await runAudit(SITE, { fetcher: healthySite().fetcher })
    const fixes = buildFixes({ id: 1, name: 'Gem Pay (main)', base_url: 'https://gempay.test', platform: 'wordpress', host: 'siteground', campaign: 'jewelers' }, r.checks, r.pages, r.sitemapUrls)
    const t = (id: string) => fixes.find((f) => f.check_id === id)
    expect(t('sitemap')?.action).toEqual({ type: 'hide_pages', urls: ['https://gempay.test/test-inner-page-2/', 'https://gempay.test/thank-you/'] })
    const canon = t('canonical')!.action
    expect(canon).toMatchObject({ type: 'set_meta', field: 'canonical', current: 'https://www.gempay.test/partners/', proposed: 'https://gempay.test/partners/' })
    const offer = t('schema_offer')!.action
    expect(offer.type).toBe('add_schema')
    if (offer.type === 'add_schema') {
      const j = JSON.parse(offer.proposed)
      expect(j['@type']).toBe('Service')
      expect(j.offers.price).toBe('99') // from the page's own "$99/month"
    }
    expect(t('h1')?.action.type).toBe('manual')
    expect(t('pagespeed')?.action.type).toBe('manual')
    // most important first
    expect(fixes.map((f) => f.priority)).toEqual([...fixes.map((f) => f.priority)].sort((a, b) => b - a))
  })

  it('non-WordPress sites get copy-paste files instead of WordPress buttons', () => {
    const fixes = buildFixes(
      { id: 2, name: 'Builders', base_url: 'https://b.lovable.app', platform: 'lovable', host: 'lovable', campaign: 'builders' },
      [{ id: 'llms_txt', label: 'llms.txt', status: 'warn', detail: 'none' }],
      { '/': { url: 'https://b.lovable.app/', title: 'TapDash | Builders', description: 'Pay for builders', canonical: null, h1: ['x'], schemaTypes: [], monthlyPrice: null, wordCount: 900 } },
      null,
    )
    expect(fixes[0].action.type).toBe('copy_file')
    if (fixes[0].action.type === 'copy_file') {
      expect(fixes[0].action.content).toContain('# TapDash | Builders')
      expect(fixes[0].action.where).toContain('Lovable')
    }
  })
})
