import { describe, expect, it } from 'vitest'
import { runAudit, summarize } from '@/lib/seo/audit'
import { buildFixes, contentDrafts } from '@/lib/seo/fixes'
import { fakeWeb, healthySite, page, WALL } from './helpers/seo-fake-web'

const SITE = { base_url: 'https://gempay.test', platform: 'wordpress', host: 'siteground', pages: ['/jewelers/', '/partners/'] }

describe('runAudit', () => {
  it('audits a readable WordPress site and finds the real problems', async () => {
    const web = healthySite()
    const r = await runAudit(SITE, { fetcher: web.fetcher })
    const by = (id: string, page?: string) => r.checks.find((c) => c.id === id && (page === undefined || c.page === page))
    expect(by('bot_wall')?.status).toBe('pass')
    expect(by('robots')?.status).toBe('pass')
    expect(by('llms_txt')?.status).toBe('info')
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

  it('a bot wall makes page checks blocked (with the reason) and becomes the top failure', async () => {
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
    expect(r.checks.find((c) => c.id === 'page')?.status).toBe('blocked')
    expect(r.checks.find((c) => c.id === 'llms_txt')?.status).toBe('blocked')
    expect(r.checks.find((c) => c.id === 'llms_txt')?.reason).toBe('Blocked: SiteGround captcha (HTTP 202)')
    const s = summarize(r.checks)
    expect(s.failed).toBe(1)
    expect(s.blocked).toBe(3)
    const fixes = buildFixes({ id: 1, name: 'W', base_url: 'https://walled.test', platform: 'wordpress', host: 'siteground', campaign: null }, r.checks, r.pages, r.sitemapUrls)
    expect(fixes[0].check_id).toBe('bot_wall')
    expect(fixes[0].action.type).toBe('manual')
    // unknowns caused by the wall don't become their own fixes
    expect(fixes.some((f) => f.check_id === 'llms_txt')).toBe(false)
  })

  it('tapdash.co from a cloud server: SiteGround 202 captcha and bare 403s are "blocked" with a reason, never a false Fix', async () => {
    const SG = { status: 202, body: WALL }
    const F403 = { status: 403, body: '<html><head><title>403 Forbidden</title></head><body>Forbidden</body></html>' }
    const web = fakeWeb({
      'https://td.test/robots.txt': { body: 'User-agent: *\nDisallow:\n\nSitemap: https://td.test/sitemap_index.xml\n', type: 'text/plain' },
      'https://td.test/sitemap_index.xml': SG,
      'https://td.test/sitemap.xml': SG,
      'https://td.test/wp-sitemap.xml': SG,
      'https://td.test/llms.txt': F403,
      'https://td.test/': F403,
      'https://td.test/jewelers/': SG,
    })
    const r = await runAudit({ base_url: 'https://td.test', platform: 'wordpress', host: 'siteground', pages: ['/jewelers/'] }, { fetcher: web.fetcher })
    const by = (id: string, page?: string) => r.checks.find((c) => c.id === id && (page === undefined || c.page === page))!
    expect(by('sitemap').status).toBe('blocked')
    expect(by('sitemap').detail).toBe("Blocked: SiteGround captcha (HTTP 202). Couldn't read the sitemap, so this is not a site failure. Open https://td.test/sitemap_index.xml in a normal browser to confirm it's live.")
    expect(by('llms_txt').status).toBe('blocked')
    expect(by('llms_txt').reason).toBe('Blocked: server refused access (HTTP 403)')
    expect(by('llms_txt').detail).toContain('SiteGround, whose anti-bot often refuses cloud servers')
    expect(by('page', '/').reason).toBe('Blocked: server refused access (HTTP 403)')
    expect(by('page', '/jewelers/').reason).toBe('Blocked: SiteGround captcha (HTTP 202)')
    // The bot wall check agrees with what the checker hit, and names the reasons.
    expect(by('bot_wall').status).toBe('fail')
    expect(by('bot_wall').detail).toContain('6 of our 7 requests were blocked')
    expect(by('bot_wall').detail).toContain('SiteGround captcha (HTTP 202) ×4')
    expect(by('bot_wall').detail).toContain('server refused access (HTTP 403) ×2')
    const s = summarize(r.checks)
    expect(s.failed).toBe(1) // the bot wall only
    expect(s.blocked).toBe(4)
    const fixes = buildFixes({ id: 1, name: 'T', base_url: 'https://td.test', platform: 'wordpress', host: 'siteground', campaign: null }, r.checks, r.pages, r.sitemapUrls)
    // Only the bot wall (plus the key-less PageSpeed setup task); nothing for sitemap, llms.txt or pages.
    expect(fixes.map((f) => f.check_id).sort()).toEqual(['bot_wall', 'pagespeed'])
  })

  it('genuinely missing things still fail; server errors say why and are not fails', async () => {
    const web = fakeWeb({
      'https://m.test/robots.txt': { body: 'User-agent: *\nDisallow:\n', type: 'text/plain' },
      'https://m.test/': { body: page({ title: 'Home page', description: 'x', canonical: 'https://m.test/', h1: ['H'] }) },
      'https://m.test/down/': { status: 502, body: '<title>Bad gateway</title>' },
    })
    const r = await runAudit({ base_url: 'https://m.test', pages: ['/gone/', '/down/'] }, { fetcher: web.fetcher })
    const by = (id: string, page?: string) => r.checks.find((c) => c.id === id && (page === undefined || c.page === page))!
    expect(by('sitemap').status).toBe('fail')
    expect(by('page', '/gone/')).toMatchObject({ status: 'fail', reason: 'Not found (HTTP 404)' })
    expect(by('page', '/down/')).toMatchObject({ status: 'unknown', reason: 'Server error: bad gateway (HTTP 502)' })
    expect(by('bot_wall').status).toBe('pass')
  })

  it('training opt-outs are policy choices, not search failures', async () => {
    const web = fakeWeb({
      'https://b.test/robots.txt': { body: 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n', type: 'text/plain' },
      'https://b.test/': { body: '<html><head><title>B</title></head><body><h1>B</h1></body></html>' },
    })
    const r = await runAudit({ base_url: 'https://b.test' }, { fetcher: web.fetcher })
    const c = r.checks.find((x) => x.id === 'robots')!
    expect(c.status).toBe('pass')
    const policy = r.checks.find((x) => x.id === 'crawler_policy')!
    expect(policy.status).toBe('info')
    expect(policy.detail).toContain('GPTBot')
    expect(policy.detail).toContain('ClaudeBot')
    expect(c.fix).toBeUndefined()
    expect(r.checks.find((x) => x.id === 'sitemap')?.status).toBe('fail')
    expect(r.checks.find((x) => x.id === 'thin')?.status).toBe('warn')
  })

  it('finds search blocking on a tracked page even when the root is allowed', async () => {
    const web = fakeWeb({ 'https://b.test/robots.txt': { body: 'User-agent: OAI-SearchBot\nDisallow: /jewelers/\n\nUser-agent: GPTBot\nDisallow: /\n', type: 'text/plain' } })
    const r = await runAudit({ base_url: 'https://b.test', pages: ['/jewelers/'] }, { fetcher: web.fetcher })
    const c = r.checks.find((x) => x.id === 'robots')!
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('OAI-SearchBot at /jewelers/')
    expect(c.detail).not.toContain('GPTBot')
    expect(c.fix).toContain('training policy')
  })

  it('missing llms.txt and absent FAQ text are informational, not required fixes', async () => {
    const r = await runAudit({ base_url: 'https://b.test' }, { fetcher: fakeWeb({ 'https://b.test/': { body: '<html><body><h1>Business</h1></body></html>' } }).fetcher })
    expect(r.checks.find((c) => c.id === 'llms_txt')).toMatchObject({ status: 'info' })
    expect(r.checks.find((c) => c.id === 'schema_faq')).toMatchObject({ status: 'info' })
    const site = { id: 1, name: 'B', base_url: 'https://b.test', platform: 'wordpress', host: null, campaign: 'jewelers' }
    expect(buildFixes(site, r.checks, r.pages, r.sitemapUrls).some((f) => ['llms_txt', 'schema_faq', 'crawler_policy'].includes(f.check_id))).toBe(false)
    expect(contentDrafts(site, null, [{ name: 'Competitor', count: 1 }])).toEqual([])
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
      [{ id: 'schema_faq', label: 'FAQ schema', status: 'warn', detail: 'Visible FAQ text has no markup', page: '/' }],
      { '/': { url: 'https://b.lovable.app/', title: 'TapDash | Builders', description: 'Pay for builders', canonical: null, h1: ['x'], schemaTypes: [], monthlyPrice: null, wordCount: 900 } },
      null,
    )
    expect(fixes[0].action.type).toBe('copy_file')
    if (fixes[0].action.type === 'copy_file') {
      expect(fixes[0].action.content).toContain('FAQPage')
      expect(fixes[0].action.where).toContain('application/ld+json')
    }
  })
})
