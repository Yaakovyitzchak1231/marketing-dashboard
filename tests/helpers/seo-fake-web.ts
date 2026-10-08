import type { Fetcher } from '@/lib/seo/audit'

/** A tiny fake web: url -> {status, body, type}. Unknown URLs answer 404. Records every URL asked. */
export function fakeWeb(pages: Record<string, { status?: number; body: string; type?: string }>) {
  const asked: string[] = []
  const fetcher: Fetcher = async (url) => {
    asked.push(url)
    const p = pages[url]
    const status = p ? (p.status ?? 200) : 404
    const body = p ? p.body : '<!doctype html><html><body>Not found</body></html>'
    return {
      status,
      url,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (p?.type ?? 'text/html; charset=utf-8') : null) },
      text: async () => body,
    }
  }
  return { fetcher, asked }
}

export const WALL = '<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F&y=ipr:1.2.3.4:1"></meta></head></html>'

export function page(opts: { title?: string; description?: string; canonical?: string; h1?: string[]; ld?: unknown[]; body?: string; robots?: string; generator?: string }) {
  const metas = [
    opts.description ? `<meta name="description" content="${opts.description}">` : '',
    opts.robots ? `<meta name="robots" content="${opts.robots}">` : '',
    opts.generator ? `<meta name="generator" content="${opts.generator}">` : '',
    opts.canonical ? `<link rel="canonical" href="${opts.canonical}">` : '',
    ...(opts.ld ?? []).map((j) => `<script type="application/ld+json">${typeof j === 'string' ? j : JSON.stringify(j)}</script>`),
  ].join('\n')
  const words = opts.body ?? Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ')
  return `<!doctype html><html><head><title>${opts.title ?? ''}</title>${metas}</head><body>${(opts.h1 ?? []).map((h) => `<h1>${h}</h1>`).join('')}<p>${words}</p></body></html>`
}

export const ORG = { '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', name: 'Gem Pay' }, { '@type': 'WebSite' }] }
export const FAQ = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q', acceptedAnswer: { '@type': 'Answer', text: 'A' } }] }

/** A healthy WordPress site at https://gempay.test with one test page in its sitemap and a www canonical on /partners/. */
export function healthySite() {
  return fakeWeb({
    'https://gempay.test/robots.txt': { body: 'User-agent: *\nDisallow:\n\nSitemap: https://gempay.test/sitemap_index.xml\n', type: 'text/plain' },
    'https://gempay.test/llms.txt': { body: '# Gem Pay: card processing\n\n## Pages\n- [Jewelers](https://gempay.test/jewelers/): x\n- [Compare](https://gempay.test/compare/): y\n- [Home](https://gempay.test/): z\n', type: 'text/plain' },
    'https://gempay.test/sitemap_index.xml': { body: '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://gempay.test/page-sitemap.xml</loc></sitemap></sitemapindex>', type: 'application/xml' },
    'https://gempay.test/page-sitemap.xml': {
      body: '<urlset><url><loc>https://gempay.test/</loc></url><url><loc>https://gempay.test/jewelers/</loc></url><url><loc>https://gempay.test/test-inner-page-2/</loc></url><url><loc>https://gempay.test/thank-you/</loc></url></urlset>',
      type: 'application/xml',
    },
    'https://gempay.test/': { body: page({ title: 'Gem Pay | Card Processing', description: 'Card processing for independent retailers.', canonical: 'https://gempay.test/', h1: [], ld: [ORG, FAQ], generator: 'WordPress 7.1.3' }) },
    'https://gempay.test/jewelers/': {
      body: page({ title: 'Card Processing for Jewelers | Gem Pay', description: 'For jewelers. $99/month platform fee.', canonical: 'https://gempay.test/jewelers/', h1: ['Your money, your rep'], ld: [ORG, FAQ], body: `Flat $99/month platform fee. ${'text '.repeat(400)}` }),
    },
    'https://gempay.test/partners/': {
      body: page({ title: 'Gem Pay: Explore Our Lucrative Partnership Programs', description: 'Take your business to the next level with us.', canonical: 'https://www.gempay.test/partners/', h1: ['Partner Program'], ld: [ORG] }),
    },
  })
}
