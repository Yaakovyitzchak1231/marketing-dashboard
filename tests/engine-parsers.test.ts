import { describe, expect, it } from 'vitest'
import { hostOf, regDomain, isPlatform, parseCityState } from '@/engine/parse/domains'
import { buildPb, parseMapsBody, parsePlaces, isBlocked, placeKey } from '@/engine/parse/maps'
import { classifyPlace } from '@/engine/parse/filter'
import {
  cfDecode, extractEmails, isPlaceholder, contactLinks, namesFromText, jsonldNames, otherBusiness, nameFromLocal, chooseOwner,
  techSignals, validName,
} from '@/engine/parse/extract'
import { hitsFromSerper, hitsFromSearxng, ownersFromHits, domainEmailsFromHits, shortStore } from '@/engine/parse/search'
import { parseRobots } from '@/engine/io/robots'
import { normalizeFindParams, ParamsError, JEWELER_QUERIES } from '@/engine/params'
import { ProxyPool, redactProxy } from '@/engine/io/http'
import { placesFromFile } from '@/engine/findLeads'
import { mapsBody, mkPlace } from './fixtures/engine-maps'

const FIRST = new Set(['sarah', 'david', 'maria', 'kari', 'michael', 'jane', 'john', 'ken', 'clint', 'ruby', 'mike'])

function cfEncode(s: string, key = 0x2a): string {
  return [key, ...[...s].map((c) => c.charCodeAt(0) ^ key)].map((n) => n.toString(16).padStart(2, '0')).join('')
}

describe('domains', () => {
  it('normalizes hosts and registrable domains', () => {
    expect(hostOf('https://www.GemCo.com/contact?x=1')).toBe('gemco.com')
    expect(hostOf('gemco.com')).toBe('gemco.com')
    expect(hostOf('nan')).toBe('')
    expect(regDomain('shop.gemco.com')).toBe('gemco.com')
    expect(regDomain('www.store.co.uk')).toBe('store.co.uk')
    expect(isPlatform('mystore.wixsite.com')).toBe(true)
    expect(isPlatform('gemco.com')).toBe(false)
    expect(parseCityState('12 Main St, Towson, MD 21204')).toEqual({ city: 'Towson', state: 'MD' })
  })
})

describe('maps', () => {
  it('fills the pb template', () => {
    const tpl = '!1sdiamond store!4m8!1m3!1d98813.5!2d-76.61!3d39.29!3m2!7i20!10b1'
    const pb = buildPb(tpl, 'goldsmith Towson MD', 39.4, -76.6, 30000, 20)
    expect(pb).toContain('!1sgoldsmith Towson MD')
    expect(pb).toContain('!1d30000!2d-76.6!3d39.4')
    expect(pb).toContain('!7i20!8i20')
  })
  it('parses places from a response body', () => {
    const body = mapsBody([
      mkPlace({ name: 'Gem Co', website: 'https://gemco.com/', phone: '(410) 555-0101', address: '1 Main St, Towson, MD 21204', categories: ['Jewelry store'], cid: '123', reviews: 40 }),
      mkPlace({ name: 'No Site Jewelers', categories: ['Jeweler'] }),
    ])
    const places = parsePlaces(parseMapsBody(body))
    expect(places).toHaveLength(2)
    expect(places[0]).toMatchObject({ name: 'Gem Co', website: 'https://gemco.com/', phone: '(410) 555-0101', categories: ['Jewelry store'], cid: '123', reviews: 40 })
    expect(places[1].website).toBeNull()
    expect(placeKey(places[0])).toBe('123')
  })
  it('detects the block page', () => {
    expect(isBlocked(429, 'https://www.google.com/search')).toBe(true)
    expect(isBlocked(200, 'https://www.google.com/sorry/index?continue=')).toBe(true)
    expect(isBlocked(200, 'https://www.google.com/search?tbm=map')).toBe(false)
  })
})

describe('filter (jewelers)', () => {
  const base = mkPlaceObj({ name: 'Gem Co Jewelers', website: 'https://gemco.com', categories: ['Jewelry store'], address: '1 Main St, Towson, MD 21204' })
  it('keeps an independent store with its domain and place', () => {
    expect(classifyPlace(base, 'jeweler')).toEqual({ keep: true, domain: 'gemco.com', city: 'Towson', state: 'MD' })
  })
  it('drops chains, pawn shops, non-jewelers, platform sites and no website', () => {
    expect(classifyPlace({ ...base, name: 'Kay Jewelers' }, 'jeweler')).toMatchObject({ keep: false, reason: 'chain_or_nonjeweler_name' })
    expect(classifyPlace({ ...base, name: 'Main Street Pawn' }, 'jeweler')).toMatchObject({ keep: false, reason: 'chain_or_nonjeweler_name' })
    expect(classifyPlace({ ...base, website: 'https://www.zales.com/store/1' }, 'jeweler')).toMatchObject({ reason: 'chain_domain' })
    expect(classifyPlace({ ...base, categories: ['Bakery'] }, 'jeweler')).toMatchObject({ reason: 'not_jeweler_category' })
    expect(classifyPlace({ ...base, categories: ['Pawn shop', 'Jewelry store'] }, 'jeweler')).toMatchObject({ reason: 'pawn_buyer_or_other_primary' })
    expect(classifyPlace({ ...base, website: 'https://facebook.com/gemco' }, 'jeweler')).toMatchObject({ reason: 'website_is_platform_page' })
    expect(classifyPlace({ ...base, website: null }, 'jeweler')).toMatchObject({ reason: 'no_website' })
    expect(classifyPlace({ ...base, address: '1 Rue X, Paris, ZZ 75001' }, 'jeweler')).toMatchObject({ reason: 'non_us' })
  })
  it('file rows without categories are not dropped for missing categories', () => {
    expect(classifyPlace({ ...base, categories: [] }, 'jeweler', { requireCategory: false })).toMatchObject({ keep: true })
    expect(classifyPlace({ ...base, categories: [], name: 'Zales' }, 'jeweler', { requireCategory: false })).toMatchObject({ keep: false })
  })
  it('ai agencies use their own category rule', () => {
    expect(classifyPlace({ ...base, name: 'Bright AI', categories: ['Software company'] }, 'ai_agency')).toMatchObject({ keep: true })
    expect(classifyPlace({ ...base, name: 'Fix My PC', categories: ['Computer repair service'] }, 'ai_agency')).toMatchObject({ keep: false })
  })
})

function mkPlaceObj(o: Partial<ReturnType<typeof parsePlaces>[number]>) {
  return { name: 'X', website: null, phone: null, address: null, categories: [], lat: null, lng: null, city: null, state: null, rating: null, reviews: null, place_id: null, cid: null, ...o }
}

describe('email extraction', () => {
  it('reads mailto, text, Cloudflare, JSON-LD and "[at]" obfuscation; drops junk and placeholders', () => {
    const html = `
      <a href="mailto:Sarah@GemCo.com?subject=hi">Email Sarah</a>
      <p>Write to info@gemco.com.</p>
      <span class="__cf_email__" data-cfemail="${cfEncode('owner@gemco.com')}">[email protected]</span>
      <a href="/cdn-cgi/l/email-protection#${cfEncode('repairs@gemco.com', 0x11)}">x</a>
      <script type="application/ld+json">{"@type":"JewelryStore","email":"store@gemco.com"}</script>
      <p>Or david [at] gemco [dot] com</p>
      <p>Email format: first.last@gemco.com or jsmith@gemco.com</p>
      <img src="logo@2x.png"> <p>bug@sentry.io noreply@gemco.com</p>`
    const got = Object.fromEntries(extractEmails(html).map((e) => [e.email, e.how]))
    expect(got['sarah@gemco.com']).toBe('mailto')
    expect(got['info@gemco.com']).toBe('text')
    expect(got['owner@gemco.com']).toBe('cloudflare')
    expect(got['repairs@gemco.com']).toBe('cloudflare')
    expect(got['store@gemco.com']).toBe('jsonld')
    expect(got['david@gemco.com']).toBe('obfuscated')
    expect(got['first.last@gemco.com']).toBeUndefined()
    expect(got['jsmith@gemco.com']).toBeUndefined()
    expect(got['bug@sentry.io']).toBeUndefined()
    expect(got['noreply@gemco.com']).toBeUndefined()
  })
  it('cfDecode inverts the Cloudflare XOR', () => {
    expect(cfDecode(cfEncode('a.b@c.com', 0x7f))).toBe('a.b@c.com')
  })
  it('placeholder rules (search snippets are stricter)', () => {
    expect(isPlaceholder('firstname@x.com')).toBe(true)
    expect(isPlaceholder('john@x.com')).toBe(false)
    expect(isPlaceholder('john@x.com', true)).toBe(true)
  })
})

describe('contact links', () => {
  it('finds same-site contact/about pages, contact first', () => {
    const html = `<a href="/about-us">About</a><a href="https://gemco.com/contact">Contact</a><a href="https://other.com/contact">x</a><a href="/rings">Rings</a><a href="/team.jpg">pic</a>`
    expect(contactLinks(html, 'https://gemco.com/')).toEqual(['https://gemco.com/contact', 'https://gemco.com/about-us'])
  })
})

describe('owner names', () => {
  it('reads owner lines and validates first names', () => {
    const text = 'Gem Co was founded in 1987 by Sarah Klein. Meet the owner, David Rosen. Ruby Diamond is our favorite stone. Our President, Michael Tran, welcomes you.'
    const names = namesFromText(text, FIRST).map((n) => `${n.name}:${n.how}`)
    expect(names).toContain('Sarah Klein:owned_by')
    expect(names).toContain('David Rosen:meet')
    expect(names.some((n) => n.startsWith('Michael Tran'))).toBe(true)
    expect(names.some((n) => n.startsWith('Ruby'))).toBe(false)
  })
  it('rejects brand and store words', () => {
    expect(validName('Sarah Jewelers', FIRST)).toBe(false)
    expect(validName('Zelda Klein', FIRST)).toBe(false)
  })
  it('reads JSON-LD founders', () => {
    const html = '<script type="application/ld+json">{"@type":"Organization","founder":{"@type":"Person","name":"Maria Lopez"}}</script>'
    expect(jsonldNames(html, FIRST)).toEqual([expect.objectContaining({ name: 'Maria Lopez', how: 'jsonld_founder' })])
  })
  it('drops a name tied to a different business', () => {
    const hit = { name: 'Kari Smith', ctx: 'In 2010 Kari Smith opened Champaign Jewelers downtown and still runs it.' }
    expect(otherBusiness(hit, 'Gem Co', 'gemco.com')).toBe('Champaign Jewelers')
    const own = { name: 'Kari Smith', ctx: 'Kari Smith, owner of Gem Co, says hello.' }
    expect(otherBusiness(own, 'Gem Co', 'gemco.com')).toBe('')
  })
  it('first names from email local parts', () => {
    expect(nameFromLocal('sarah', FIRST)).toBe('Sarah')
    expect(nameFromLocal('mike.jones', FIRST)).toBe('Mike')
    expect(nameFromLocal('info', FIRST)).toBe('')
    expect(nameFromLocal('ruby', FIRST)).toBe('')
  })
  it('chooses the owner with confidence', () => {
    const hits = [
      { name: 'Sarah Klein', how: 'owned_by' as const, ctx: '', url: 'https://gemco.com/about' },
      { name: 'Jane Doe', how: 'i_am_first' as const, ctx: '', url: 'https://gemco.com/' },
    ]
    expect(chooseOwner(hits, ['sarah@gemco.com'])).toMatchObject({ name: 'Sarah Klein', confidence: 'high' })
    expect(chooseOwner([], [])).toBeNull()
    expect(chooseOwner([{ name: 'Jane Doe', how: 'meet' as const, ctx: '', url: 'u' }], [])).toMatchObject({ confidence: 'medium' })
  })
})

describe('signals', () => {
  it('spots platforms, payments and surcharge wording', () => {
    const s = techSignals('<script src="https://cdn.shopify.com/s/x.js"></script> <script src="https://js.stripe.com/v3"></script> A 3% credit card surcharge applies.')
    expect(s).toEqual(expect.arrayContaining(['shopify', 'stripe', 'surcharge_wording']))
  })
})

describe('search parsing', () => {
  const serper = {
    organic: [
      { title: 'Gem Co - Towson jeweler', link: 'https://gemco.com/about', snippet: 'Gem Co is owned by Sarah Klein since 1987. Email sarah@gemco.com or jane.doe@gemco.com.' },
      { title: 'Champaign Jewelers', link: 'https://news.example/x', snippet: 'Kari Smith opened Champaign Jewelers in 2010.' },
    ],
    knowledgeGraph: { title: 'Gem Co', website: 'https://gemco.com' },
  }
  it('reduces Serper and SearXNG to hits', () => {
    expect(hitsFromSerper(serper)).toHaveLength(3)
    expect(hitsFromSearxng({ results: [{ title: 't', url: 'u', content: 'c' }] })).toEqual([{ title: 't', link: 'u', snippet: 'c' }])
  })
  it('owner names only from snippets about this store', () => {
    const owners = ownersFromHits(hitsFromSerper(serper), 'Gem Co', 'gemco.com', FIRST)
    expect(owners.map((o) => o.name)).toEqual(['Sarah Klein'])
  })
  it('@domain emails without placeholders', () => {
    expect(domainEmailsFromHits(hitsFromSerper(serper), 'gemco.com').map((e) => e.email)).toEqual(['sarah@gemco.com'])
  })
  it('short store words', () => {
    expect(shortStore('Smith & Sons Fine Jewelers')).toEqual(['Smith', 'Sons'])
  })
})

describe('robots.txt', () => {
  it('honors the * group with longest-match allow', () => {
    const r = parseRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/contact\nDisallow: /*.pdf$')
    expect(r.allows('/contact')).toBe(true)
    expect(r.allows('/private/x')).toBe(false)
    expect(r.allows('/private/contact')).toBe(true)
    expect(r.allows('/files/a.pdf')).toBe(false)
  })
})

describe('params', () => {
  it('fills defaults from the measured query set', () => {
    const p = normalizeFindParams({ states: 'md, va', max_businesses: '25' })
    expect(p).toMatchObject({ segment: 'jeweler', queries: JEWELER_QUERIES, geography: { states: ['MD', 'VA'] }, max_businesses: 25, stages: ['discover', 'crawl', 'owner', 'build'], proxies: false })
    expect(p.concurrency).toEqual({ maps: 6, crawl: 8 })
    expect(normalizeFindParams({ cities: 'Towson, MD; Columbia, MD' }).geography.cities).toEqual(['Towson, MD', 'Columbia, MD'])
  })
  it('refuses bad input in plain words', () => {
    expect(() => normalizeFindParams({})).toThrow(ParamsError)
    expect(() => normalizeFindParams({ states: ['Maryland'] })).toThrow(/2-letter/)
    expect(() => normalizeFindParams({ cities: ['Towson'] })).toThrow(/Towson, MD/)
    expect(() => normalizeFindParams({ states: ['MD'], stages: ['crawl'] })).toThrow(/discover/)
  })
})

describe('proxy pool', () => {
  it('rotates and rests a failing proxy; never prints credentials', () => {
    const pool = new ProxyPool(['http://u:p@a:1', 'http://u:p@b:2'])
    expect([pool.next(), pool.next(), pool.next()]).toEqual(['http://u:p@a:1', 'http://u:p@b:2', 'http://u:p@a:1'])
    for (let i = 0; i < 3; i++) pool.report('http://u:p@b:2', false)
    expect([pool.next(), pool.next()]).toEqual(['http://u:p@a:1', 'http://u:p@a:1'])
    expect(redactProxy('http://user:secret@host:8080')).toBe('http://host:8080')
    expect(new ProxyPool([]).next()).toBeNull()
  })
})

describe('file source', () => {
  it('reads CSV (quoted) and JSONL', () => {
    const csv = 'name,website,phone,city,state\n"Gem Co, Inc",gemco.com,4105550101,Towson,MD\n'
    expect(placesFromFile(csv)[0]).toMatchObject({ name: 'Gem Co, Inc', website: 'gemco.com', city: 'Towson', state: 'MD' })
    expect(placesFromFile('{"name":"A","website":"a.com"}\n{"name":"B"}')).toHaveLength(2)
  })
})
