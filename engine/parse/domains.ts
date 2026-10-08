/**
 * Hosts, domains and phones, ported from tapdash_scraper/scraper.py (host_of,
 * reg_domain, is_platform, norm_phone) plus the chain / platform lists that
 * decided which Maps results were real independent stores.
 */

/** Lowercase host without www., or '' when the value is not a URL. */
export function hostOf(url: string | null | undefined): string {
  let u = String(url ?? '').trim()
  if (!u || ['nan', 'none', 'null'].includes(u.toLowerCase())) return ''
  if (!u.includes('://')) u = 'http://' + u
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/\.$/, '')
    return h.startsWith('www.') ? h.slice(4) : h
  } catch {
    return ''
  }
}

/** Registrable domain: shop.example.com -> example.com, a.example.co.uk -> example.co.uk. */
export function regDomain(host: string | null | undefined): string {
  let h = String(host ?? '').toLowerCase().replace(/^\.+|\.+$/g, '')
  if (h.startsWith('www.')) h = h.slice(4)
  const parts = h.split('.')
  if (parts.length >= 3 && ['co', 'com', 'net', 'org'].includes(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) {
    return parts.slice(-3).join('.')
  }
  return parts.length >= 2 ? parts.slice(-2).join('.') : h
}

/** Website builders, directories and social profiles: not a store's own site. */
export const PLATFORM_HOSTS = [
  'facebook.com', 'instagram.com', 'yelp.com', 'linktr.ee', 'sites.google.com', 'business.site', 'wixsite.com', 'weebly.com',
  'square.site', 'myshopify.com', 'godaddysites.com', 'jewelershowcase.com', 'hibuwebsites.com', 'landingsite.ai',
  'business.google.com', 'g.page', 'tiktok.com', 'etsy.com', 'squarespace.com', 'wordpress.com', 'blogspot.com', 'yolasite.com',
  'webs.com', 'mapquest.com', 'yellowpages.com', 'bbb.org', 'twitter.com', 'x.com', 'youtube.com', 'google.com', 'goo.gl', 'bit.ly',
  'ueniweb.com', 'site123.me', 'jimdosite.com', 'webnode.page', 'carrd.co', 'booksy.com', 'vagaro.com', 'amazon.com', 'ebay.com',
  'nextdoor.com', 'yelp.to', 'wix.com', 'mystrikingly.com', 'strikingly.com', 'dudaone.com', 'multiscreensite.com', 'shopify.com',
  'square.com', 'linkin.bio', 'beacons.ai', 'msn.com', 'thumbtack.com', 'homeadvisor.com', 'angi.com', 'company.site',
  'my.canva.site', 'canva.site', 'netlify.app', 'vercel.app', 'usabizlink.top', 'bizlinkusa.com', 'linkedin.com', 'pinterest.com',
  'faire.com', 'shop.app', 'goaffpro.com', 'zola.com', 'theknot.com', 'weddingwire.com', 'github.io', 'secureserver.net',
  'joomla.com', 'tripod.com', 'webflow.io', 'hubspot.com',
]

export function isPlatform(host: string): boolean {
  return PLATFORM_HOSTS.some((p) => host === p || host.endsWith('.' + p))
}

export const FREEMAIL = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'aol.com', 'outlook.com', 'icloud.com', 'msn.com', 'live.com', 'comcast.net', 'att.net',
  'sbcglobal.net', 'verizon.net', 'bellsouth.net', 'me.com', 'mac.com', 'ymail.com', 'cox.net', 'charter.net', 'earthlink.net',
  'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'rocketmail.com', 'optonline.net', 'frontier.com', 'windstream.net',
  'centurylink.net', 'q.com', 'juno.com', 'netzero.net', 'usa.com', 'roadrunner.com', 'twc.com', 'rr.com', 'embarqmail.com',
  'aim.com', 'zoho.com', 'hughes.net', 'suddenlink.net',
])

/** 10-digit US phone (no country code) or ''. */
export function phone10(p: string | null | undefined): string {
  let d = String(p ?? '').replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1)
  return d.length === 10 ? d : ''
}

export const STATE_ABBR: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR',
  Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
}
export const US_STATES = new Set(Object.values(STATE_ABBR))

/** "123 Main St, Towson, MD 21204" -> { city: 'Towson', state: 'MD' } */
export function parseCityState(addr: string | null | undefined): { city: string | null; state: string | null } {
  const m = /,\s*([^,]+),\s*([A-Z]{2})\s*\d{5}/.exec(addr ?? '')
  return m ? { city: m[1].trim(), state: m[2] } : { city: null, state: null }
}
