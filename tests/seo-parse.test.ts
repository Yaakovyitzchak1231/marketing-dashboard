import { describe, expect, it } from 'vitest'
import { detectBotWall, parseLlmsTxt, parsePage, parseRobots, parseSitemap, robotsAllows, suspiciousSitemapUrls } from '@/lib/seo/parse'
import { lineDiff } from '@/lib/seo/diff'
import { WALL, page, FAQ } from './helpers/seo-fake-web'

describe('robots.txt', () => {
  it('allows everything for "Disallow:" (empty) and reads Sitemap lines', () => {
    const r = parseRobots('# START YOAST BLOCK\nUser-agent: *\nDisallow:\n\nSitemap: https://x.test/sitemap_index.xml\n')
    expect(r.sitemaps).toEqual(['https://x.test/sitemap_index.xml'])
    expect(robotsAllows(r, 'GPTBot').allowed).toBe(true)
  })
  it('uses the most specific group and the longest rule', () => {
    const r = parseRobots('User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\nAllow: /blog/\n')
    expect(robotsAllows(r, 'Mozilla/5.0; compatible; GPTBot/1.2').allowed).toBe(false)
    expect(robotsAllows(r, 'ClaudeBot', '/blog/post').allowed).toBe(true)
    expect(robotsAllows(r, 'PerplexityBot').allowed).toBe(true)
  })
  it('handles wildcards and $', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$\n')
    expect(robotsAllows(r, 'Bingbot', '/a/b.pdf').allowed).toBe(false)
    expect(robotsAllows(r, 'Bingbot', '/a/b.pdf?x').allowed).toBe(true)
  })
  it('no robots groups = allowed', () => {
    expect(robotsAllows(parseRobots(''), 'GPTBot').allowed).toBe(true)
  })
})

describe('bot walls', () => {
  it('spots SiteGround\'s captcha page', () => {
    expect(detectBotWall(202, WALL)).toBe('SiteGround anti-bot captcha')
    expect(detectBotWall(200, page({ title: 'ok' }))).toBeNull()
  })
})

describe('parsePage', () => {
  it('reads title, description, canonical, h1, schema types, price', () => {
    const f = parsePage(page({ title: 'A &amp; B', description: 'Desc', canonical: '/x/', h1: ['Hello <b>there</b>'], ld: [FAQ, '{broken'], body: 'Only $99/month, no contracts.' }))
    expect(f.title).toBe('A & B')
    expect(f.description).toBe('Desc')
    expect(f.canonical).toBe('/x/')
    expect(f.h1).toEqual(['Hello there'])
    expect(f.schemaTypes).toEqual(['Answer', 'FAQPage', 'Question'])
    expect(f.schemaErrors).toBe(1)
    expect(f.monthlyPrice).toBe(99)
  })
  it('null price when the page states none', () => {
    expect(parsePage(page({ title: 'x', body: 'call us' })).monthlyPrice).toBeNull()
  })
})

describe('sitemaps and llms.txt', () => {
  it('parses index vs urlset and flags test pages', () => {
    expect(parseSitemap('<sitemapindex><sitemap><loc>https://x.test/a.xml</loc></sitemap></sitemapindex>')).toEqual({ isIndex: true, urls: ['https://x.test/a.xml'] })
    const urls = ['https://x.test/', 'https://x.test/test-inner-page-2/', 'https://x.test/test-inner-page-2-copy/', 'https://x.test/thank-you/', 'https://x.test/jewelers/compare/', 'https://x.test/latest-news/']
    expect(suspiciousSitemapUrls(urls)).toEqual(['https://x.test/test-inner-page-2/', 'https://x.test/test-inner-page-2-copy/', 'https://x.test/thank-you/'])
  })
  it('accepts markdown llms.txt, rejects an HTML page served at /llms.txt', () => {
    expect(parseLlmsTxt('# TapDash Payments: card processing\\.\n- [J](https://x.test/j/): d\n', 'text/plain')).toEqual({ valid: true, title: 'TapDash Payments: card processing.', links: ['https://x.test/j/'] })
    expect(parseLlmsTxt('<!DOCTYPE html><html>', 'text/html').valid).toBe(false)
  })
})

describe('lineDiff', () => {
  it('marks changed lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'add', text: 'B' },
      { op: 'same', text: 'c' },
    ])
    expect(lineDiff(null, 'x')).toEqual([{ op: 'add', text: 'x' }])
  })
})
