import type { AuditPage, Check } from './audit'
import { suspiciousSitemapUrls } from './parse'

/**
 * Turns audit findings into the fix list. Each fix says what's wrong, what to
 * do, and which button does it:
 *   set_meta     edit a Yoast field (title / description / canonical) — preview, diff, Apply, Undo
 *   add_schema   add JSON-LD to a page (FAQ / Service+Offer) — preview, Apply, Undo
 *   hide_pages   noindex (Yoast) or move to draft, per URL — Apply, Undo
 *   create_draft create a WordPress DRAFT page from an outline — Apply (draft only), Undo (trash)
 *   copy_file    a file to paste somewhere we can't write (llms.txt on Lovable)
 *   manual       steps only he can do (SiteGround, Elementor, keys) + "Done, re-check"
 */

export type FixAction =
  | { type: 'set_meta'; field: 'title' | 'description' | 'canonical'; current: string | null; proposed: string }
  | { type: 'add_schema'; schema: 'faq' | 'offer'; proposed: string }
  | { type: 'hide_pages'; urls: string[] }
  | { type: 'create_draft'; title: string; slug: string; content: string }
  | { type: 'copy_file'; filename: string; content: string; where: string }
  | { type: 'manual'; steps: string[] }

export interface Fix {
  key: string // dedupe key part: check id + page
  title: string
  check_id: string
  page: string | null
  severity: 'fail' | 'warn' | 'unknown'
  detail: string
  fix: string | null
  action: FixAction
  priority: number
}

export interface FixSite {
  id: number
  name: string
  base_url: string
  platform: string | null
  host: string | null
  campaign: string | null
}

const PRIORITY: Record<string, number> = {
  bot_wall: 100,
  robots: 95,
  noindex: 90,
  sitemap: 70,
  canonical: 65,
  title: 60,
  title_generic: 55,
  description: 50,
  description_generic: 48,
  h1: 45,
  schema_offer: 44,
  schema_faq: 42,
  llms_txt: 40,
  schema_org: 38,
  pagespeed: 20,
}

export function faqTemplate(site: FixSite): string {
  const brand = site.name.replace(/\s*\(.*\)\s*$/, '')
  return JSON.stringify(
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        { q: `Who is ${brand} for?`, a: 'EDIT: one sentence naming the customer (e.g. independent jewelry stores).' },
        { q: `How much does ${brand} cost?`, a: 'EDIT: the price and terms, in plain words.' },
        { q: 'Will you hold my funds on a large sale?', a: 'EDIT: your policy on holds for high-ticket sales.' },
        { q: 'Is there a long-term contract or cancellation fee?', a: 'EDIT: contract terms.' },
        { q: 'How fast can I get approved and start taking cards?', a: 'EDIT: underwriting and setup time.' },
      ].map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    },
    null,
    2,
  )
}

export function offerTemplate(site: FixSite, page: AuditPage | undefined): string {
  const brand = site.name.replace(/\s*\(.*\)\s*$/, '')
  const offer: Record<string, unknown> = {
    '@type': 'Offer',
    priceCurrency: 'USD',
    ...(page?.monthlyPrice != null
      ? {
          price: String(page.monthlyPrice),
          priceSpecification: {
            '@type': 'UnitPriceSpecification',
            price: String(page.monthlyPrice),
            priceCurrency: 'USD',
            unitText: 'MONTH',
            referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' },
          },
        }
      : { price: 'EDIT: monthly price as a number' }),
    url: page?.url ?? site.base_url,
  }
  return JSON.stringify(
    {
      '@context': 'https://schema.org',
      '@type': 'Service',
      name: page?.title ?? brand,
      serviceType: 'Credit card processing',
      provider: { '@type': 'Organization', name: brand, url: site.base_url },
      areaServed: 'US',
      audience: { '@type': 'BusinessAudience', audienceType: site.campaign === 'jewelers' ? 'Independent jewelry retailers' : 'EDIT: who this page is for' },
      description: page?.description ?? 'EDIT: one sentence on the offer',
      offers: offer,
    },
    null,
    2,
  )
}

export function llmsTxtTemplate(site: FixSite, pages: Record<string, AuditPage>): string {
  const home = pages['/']
  const lines = [`# ${home?.title ?? site.name}`, '', `> ${home?.description ?? 'EDIT: one sentence on what you do and for whom.'}`, '', '## Pages']
  for (const [path, p] of Object.entries(pages)) {
    lines.push(`- [${p.title ?? path}](${p.url})${p.description ? `: ${p.description}` : ''}`)
  }
  return `${lines.join('\n')}\n`
}

function suggestTitle(site: FixSite, page: AuditPage | undefined, path: string): string {
  const brand = site.name.replace(/\s*\(.*\)\s*$/, '')
  const h1 = page?.h1?.[0]
  if (path === '/') return `${brand} | Credit Card Processing for Independent Retailers`
  if (h1 && h1.length <= 50) return `${h1} | ${brand}`
  return `EDIT: audience + offer | ${brand}`
}

const isWp = (s: FixSite) => (s.platform ?? '').toLowerCase() === 'wordpress'

export function buildFixes(site: FixSite, checks: Check[], pages: Record<string, AuditPage>, sitemapUrls: string[] | null): Fix[] {
  const out: Fix[] = []
  const add = (f: Omit<Fix, 'priority'>) => out.push({ ...f, priority: PRIORITY[f.check_id] ?? 10 })
  for (const c of checks) {
    if (c.status === 'pass') continue
    if (c.status === 'unknown' && c.id !== 'pagespeed' && c.id !== 'robots') continue // can't fix what we couldn't read; the bot wall fix covers it
    const page = c.page ?? null
    const base = { check_id: c.id, page, severity: c.status as Fix['severity'], detail: c.detail, fix: c.fix ?? null, key: `${c.id}:${page ?? ''}` }
    const p = page ? pages[page] : undefined
    switch (c.id) {
      case 'bot_wall':
        add({
          ...base,
          title: 'Let AI crawlers past the bot wall',
          action: {
            type: 'manual',
            steps:
              (site.host ?? '').toLowerCase() === 'siteground'
                ? [
                    'Log in to SiteGround > Websites > Site Tools for this site.',
                    'Statistics > Access Log (or Traffic): search for GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, ChatGPT-User.',
                    'If their requests show status 202 (or nothing at all), they are being walled.',
                    'Open a SiteGround support chat: "Please exempt verified AI crawlers (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot) and search bots from the anti-bot captcha on this site." It is free.',
                    'Come back and press "Done, re-check".',
                  ]
                : ['Ask the host to exempt verified search and AI crawlers from the bot challenge.', 'Press "Done, re-check".'],
          },
        })
        break
      case 'robots':
        add({ ...base, title: 'Allow AI crawlers in robots.txt', action: { type: 'manual', steps: [c.fix ?? 'Edit robots.txt to allow the blocked bots.', 'Press "Done, re-check".'] } })
        break
      case 'sitemap': {
        const sus = suspiciousSitemapUrls(sitemapUrls ?? [])
        if (sus.length && isWp(site)) add({ ...base, title: `Hide ${sus.length} test/leftover page${sus.length === 1 ? '' : 's'} from Google`, action: { type: 'hide_pages', urls: sus } })
        else add({ ...base, title: sus.length ? 'Remove test pages from the sitemap' : 'Publish an XML sitemap', action: { type: 'manual', steps: [c.fix ?? '', 'Press "Done, re-check".'] } })
        break
      }
      case 'title':
      case 'title_generic':
        if (isWp(site)) add({ ...base, title: `Rewrite the title on ${page}`, action: { type: 'set_meta', field: 'title', current: p?.title ?? null, proposed: suggestTitle(site, p, page ?? '/') } })
        else add({ ...base, title: `Rewrite the title on ${page}`, action: { type: 'manual', steps: [c.fix ?? '', 'Press "Done, re-check".'] } })
        break
      case 'description':
      case 'description_generic':
        if (isWp(site)) add({ ...base, title: `Rewrite the meta description on ${page}`, action: { type: 'set_meta', field: 'description', current: p?.description ?? null, proposed: p?.description && c.id === 'description' ? p.description : 'EDIT: who it is for, what it costs, why it is different (under 155 characters).' } })
        else add({ ...base, title: `Write a meta description for ${page}`, action: { type: 'manual', steps: [c.fix ?? '', 'Press "Done, re-check".'] } })
        break
      case 'canonical':
        if (isWp(site) && p) add({ ...base, title: `Fix the canonical URL on ${page}`, action: { type: 'set_meta', field: 'canonical', current: p.canonical, proposed: p.url } })
        else add({ ...base, title: `Add a canonical URL on ${page}`, action: { type: 'manual', steps: [c.fix ?? '', 'Press "Done, re-check".'] } })
        break
      case 'h1':
        add({
          ...base,
          title: `Give ${page} one clear H1`,
          action: {
            type: 'manual',
            steps: isWp(site)
              ? [
                  `Open ${page} in WordPress > Edit with Elementor.`,
                  'Click the main headline > Content > HTML Tag: H1. Make sure no other heading on the page is H1.',
                  'Make the words say who it is for, e.g. "Card processing for independent retailers, with a real person on your account".',
                  'Update, then press "Done, re-check".',
                ]
              : [c.fix ?? 'Make the main headline an <h1>.', 'Press "Done, re-check".'],
          },
        })
        break
      case 'schema_faq':
        add({ ...base, title: `Add FAQ schema to ${page}`, action: isWp(site) ? { type: 'add_schema', schema: 'faq', proposed: faqTemplate(site) } : { type: 'copy_file', filename: 'faq-schema.json', content: faqTemplate(site), where: `Add as <script type="application/ld+json"> in the <head> of ${page}` } })
        break
      case 'schema_offer':
        add({ ...base, title: `Add price/offer schema to ${page}`, action: isWp(site) ? { type: 'add_schema', schema: 'offer', proposed: offerTemplate(site, p) } : { type: 'copy_file', filename: 'offer-schema.json', content: offerTemplate(site, p), where: `Add as <script type="application/ld+json"> in the <head> of ${page}` } })
        break
      case 'llms_txt':
        add({
          ...base,
          title: 'Publish an llms.txt',
          action: isWp(site)
            ? { type: 'manual', steps: ['WordPress > Yoast SEO > Settings > Site features > llms.txt: on.', 'Choose "manual page selection" and pick the offer, pricing, comparison and FAQ pages; give the home page a real title.', 'Save, then press "Done, re-check".'] }
            : { type: 'copy_file', filename: 'llms.txt', content: llmsTxtTemplate(site, pages), where: (site.platform ?? '') === 'lovable' ? 'In Lovable, ask: "add this file as public/llms.txt" and publish.' : 'Upload to the site root as /llms.txt.' },
        })
        break
      case 'schema_org':
        add({ ...base, title: 'Add Organization schema', action: { type: 'manual', steps: [c.fix ?? '', 'Press "Done, re-check".'] } })
        break
      case 'pagespeed':
        add({
          ...base,
          title: c.status === 'unknown' ? 'Turn on speed checks (free key)' : 'Speed up the mobile site',
          action: {
            type: 'manual',
            steps:
              c.status === 'unknown'
                ? ['console.cloud.google.com > create a project (free, no billing).', 'APIs & Services > Library > "PageSpeed Insights API" > Enable.', 'Credentials > Create API key; restrict it to the PageSpeed API.', 'Add it in Vercel as PAGESPEED_API_KEY, redeploy, then press "Done, re-check".']
                : [c.fix ?? '', 'Press "Done, re-check".'],
          },
        })
        break
      default:
        add({ ...base, title: `${c.label}${page ? ` on ${page}` : ''}`, action: { type: 'manual', steps: [c.fix ?? c.detail, 'Press "Done, re-check".'] } })
    }
  }
  return out.sort((a, b) => b.priority - a.priority)
}

/** Draft-page ideas for content gaps (comparison pages, buyer guides). */
export function contentDrafts(site: FixSite, sitemapUrls: string[] | null, competitorsNamed: { name: string; count: number }[]): Fix[] {
  if (!isWp(site)) return []
  const have = new Set((sitemapUrls ?? []).map((u) => {
    try {
      return new URL(u).pathname.toLowerCase()
    } catch {
      return ''
    }
  }))
  const out: Fix[] = []
  const brand = site.name.replace(/\s*\(.*\)\s*$/, '')
  if (site.campaign === 'jewelers' && ![...have].some((p) => /best|guide/.test(p))) {
    out.push({
      key: 'draft:guide',
      title: 'Draft a buyer guide: "Best credit card processing for jewelry stores"',
      check_id: 'content_guide',
      page: null,
      severity: 'warn',
      detail: 'AI answers to "best processor for jewelry stores" cite guides and comparison pages. A guide page on your own site gives them something of yours to quote.',
      fix: 'Creates a DRAFT page in WordPress with an outline to fill in. Nothing goes live until you publish it.',
      priority: 30,
      action: {
        type: 'create_draft',
        title: 'Best Credit Card Processing for Jewelry Stores (2026 Guide)',
        slug: 'best-credit-card-processing-for-jewelry-stores',
        content: [
          '<!-- wp:paragraph --><p>EDIT: Two sentences: who this guide is for (independent jewelers) and what matters when choosing a processor for high-ticket sales.</p><!-- /wp:paragraph -->',
          '<!-- wp:heading --><h2>What jewelers should look for</h2><!-- /wp:heading -->',
          '<!-- wp:list --><ul><li>Fund holds on large tickets</li><li>A real person you can text</li><li>Contract length and cancellation fees</li><li>Dual pricing (legal in your state?)</li><li>Total monthly cost on your actual volume</li></ul><!-- /wp:list -->',
          '<!-- wp:heading --><h2>The options compared</h2><!-- /wp:heading -->',
          `<!-- wp:paragraph --><p>EDIT: ${brand}, Square, Clover, Stripe and others, one honest paragraph each. Link to the /jewelers/compare/ pages.</p><!-- /wp:paragraph -->`,
          '<!-- wp:heading --><h2>FAQ</h2><!-- /wp:heading -->',
          '<!-- wp:paragraph --><p>EDIT: 4-6 questions buyers ask, answered in one or two sentences each.</p><!-- /wp:paragraph -->',
        ].join('\n'),
      },
    })
  }
  for (const c of competitorsNamed.slice(0, 5)) {
    const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if ([...have].some((p) => p.includes(`/${slug}`))) continue
    out.push({
      key: `draft:vs:${slug}`,
      title: `Draft a comparison page: ${brand} vs ${c.name}`,
      check_id: 'content_compare',
      page: null,
      severity: 'warn',
      detail: `${c.name} came up in ${c.count} AI answer${c.count === 1 ? '' : 's'} and there's no comparison page for it on the site.`,
      fix: 'Creates a DRAFT comparison page in WordPress. Nothing goes live until you publish it.',
      priority: 28,
      action: {
        type: 'create_draft',
        title: `${brand} vs ${c.name} for Jewelers`,
        slug: `${brand.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-vs-${slug}`,
        content: [
          `<!-- wp:paragraph --><p>EDIT: One paragraph: who should pick ${brand}, who should pick ${c.name}.</p><!-- /wp:paragraph -->`,
          '<!-- wp:heading --><h2>Side by side</h2><!-- /wp:heading -->',
          '<!-- wp:paragraph --><p>EDIT: fund holds, contracts, support, pricing, high-ticket sales.</p><!-- /wp:paragraph -->',
        ].join('\n'),
      },
    })
  }
  return out
}
