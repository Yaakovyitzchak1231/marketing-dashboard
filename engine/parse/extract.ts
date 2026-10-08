/**
 * What a store's own web pages say: email addresses, owner names, phones and a
 * few signals. Ported from tapdash_scraper/scraper.py (extract, cf_decode,
 * JUNK_EMAIL_RE, PLACEHOLDER_LOCALS, name_from_local) and enrich.py
 * (NAME_RES, valid_name, jsonld_names, other_business). Pure functions.
 */
import { FREEMAIL, hostOf, regDomain } from './domains.ts'

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g
const EMAIL_FULL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$/
export const JUNK_EMAIL_RE = new RegExp(
  '(sentry|wixpress|example\\.|domain\\.com|email\\.com|yourdomain|yoursite|test@|noreply|no-reply|donotreply|' +
    '\\.(png|jpe?g|gif|webp|svg|css|js)$|@2x|godaddy|squarespace|shopify|wix\\.com|sentry\\.io|cloudflare|schema\\.org|' +
    'mysite\\.com|company\\.com|name@|user@|john@doe|jane@|privacy@|abuse@|webmaster@|postmaster@|hostmaster@|' +
    '@sentry|@w3\\.org|@jquery|@bootstrap|@[0-9]+\\.|u00|%20|webdesign|seo@|@gemfind|@jewelershowcase|@punchmark|@thinkspace|@rapnet)',
  'i',
)

/** Local parts that are examples on "email format" pages, never a real inbox. */
export const PLACEHOLDER_LOCALS = new Set([
  'first', 'last', 'first.last', 'firstlast', 'flast', 'f.last', 'firstname', 'lastname', 'first_last', 'firstl', 'jane.doe',
  'john.doe', 'jdoe', 'johndoe', 'janedoe', 'jsmith', 'john.smith', 'johnsmith', 'your', 'yourname', 'you', 'name', 'email',
  'example', 'username', 'user', 'someone', 'me', 'myname', 'abc', 'xyz', 'test', 'sample',
])

export function isPlaceholder(email: string, fromSearch = false): boolean {
  const loc = email.split('@')[0].toLowerCase()
  if (PLACEHOLDER_LOCALS.has(loc)) return true
  return fromSearch && ['john', 'jane', 'j.smith', 'j.doe', 'smith', 'doe', 'johns', 'janes'].includes(loc)
}

/** Cloudflare email protection: first byte is the XOR key. */
export function cfDecode(hex: string): string {
  try {
    const k = parseInt(hex.slice(0, 2), 16)
    let out = ''
    for (let i = 2; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k)
    return out
  } catch {
    return ''
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#64': '@', '#x40': '@', '#46': '.' }
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase()
    if (ENTITIES[k]) return ENTITIES[k]
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16) || 32)
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10) || 32)
    return m
  })
}

/** Visible text of a page: scripts/styles/svg removed, tags to spaces, entities decoded. */
export function cleanText(html: string): string {
  const noScripts = html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  return decodeEntities(noScripts.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export interface PageEmail {
  email: string
  how: 'mailto' | 'text' | 'obfuscated' | 'cloudflare' | 'jsonld'
}

/** Every plausible address on a page, with how it was found. Junk and placeholders removed. */
export function extractEmails(html: string): PageEmail[] {
  const found = new Map<string, PageEmail['how']>()
  const add = (raw: string, how: PageEmail['how']) => {
    const e = raw.trim().replace(/^mailto:/i, '').replace(/^\.+|\.+$/g, '').toLowerCase()
    if (!EMAIL_FULL.test(e) || e.length >= 70 || JUNK_EMAIL_RE.test(e) || isPlaceholder(e)) return
    if (!found.has(e) || how === 'mailto') found.set(e, how)
  }
  for (const m of html.matchAll(/data-cfemail="([0-9a-fA-F]+)"/g)) add(cfDecode(m[1]), 'cloudflare')
  for (const m of html.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]+)/g)) add(cfDecode(m[1]), 'cloudflare')
  for (const blk of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const m of blk[1].matchAll(/"email"\s*:\s*"([^"]+)"/g)) add(m[1], 'jsonld')
  }
  const t = decodeEntities(html)
  for (const m of t.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    let v = m[1]
    try {
      v = decodeURIComponent(v)
    } catch {
      /* keep raw */
    }
    add(v, 'mailto')
  }
  for (const m of t.matchAll(EMAIL_RE)) add(m[0], 'text')
  // "jane [at] store [dot] com", "jane (at) store.com"
  const text = cleanText(html)
  const obf = /([A-Za-z0-9._%+-]{1,40})\s*(?:\[at\]|\(at\)|\{at\}|\sat\s)\s*([A-Za-z0-9-]{1,63}(?:\s*(?:\[dot\]|\(dot\)|\.|\sdot\s)\s*[A-Za-z0-9-]{1,63}){1,3})/gi
  for (const m of text.matchAll(obf)) {
    if (!/\[at\]|\(at\)|\{at\}/i.test(m[0]) && !/\sdot\s|\[dot\]|\(dot\)/i.test(m[2])) continue
    const dom = m[2].replace(/\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*/gi, '.').replace(/\s+/g, '')
    const e = `${m[1]}@${dom}`
    if (!found.has(e.toLowerCase())) add(e, 'obfuscated')
  }
  return [...found].map(([email, how]) => ({ email, how }))
}

/** On the store's own domain (or a subdomain of it)? */
export function onDomain(email: string, domain: string): boolean {
  const d = email.split('@')[1] ?? ''
  return d === domain || d.endsWith('.' + domain) || regDomain(d) === domain
}
export function isFreemail(email: string): boolean {
  return FREEMAIL.has(email.split('@')[1] ?? '')
}

/** Same-site links that look like contact/about/team pages, best first. */
export function contactLinks(html: string, pageUrl: string, max = 3): string[] {
  const base = hostOf(pageUrl)
  const links: string[] = []
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    let u: URL
    try {
      u = new URL(decodeEntities(m[1]), pageUrl)
    } catch {
      continue
    }
    if (!/^https?:$/.test(u.protocol)) continue
    const h = hostOf(u.href)
    if (!h || regDomain(h) !== regDomain(base)) continue
    if (!/contact|about|our-?story|team|staff|meet|owner|family|history|who-we-are/i.test(u.pathname)) continue
    if (/\.(jpe?g|png|gif|pdf|webp|svg)$/i.test(u.pathname)) continue
    const clean = `${u.protocol}//${u.host}${u.pathname}`
    if (clean.replace(/\/$/, '') === pageUrl.split('?')[0].replace(/\/$/, '')) continue
    if (!links.includes(clean)) links.push(clean)
  }
  const rank = (u: string) => (/contact/i.test(u) ? 0 : /about|story|meet|owner|team/i.test(u) ? 1 : 2)
  links.sort((a, b) => rank(a) - rank(b) || a.length - b.length)
  return links.slice(0, max)
}

// ------------------------------------------------------------------ names

/** Case-insensitive copy of a regex source fragment (Node 22 has no inline (?i:) groups). */
function ci(src: string): string {
  return src.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`)
}

const NAMEP = "([A-Z][a-z]{1,15}(?:\\s(?:[A-Z]\\.|[A-Z][a-z]+))?\\s(?:Mc|Mac|O'|De|Di|Van |Le)?[A-Z][a-zA-Z'\\-]{1,20})"
const FIRSTONLY = '([A-Z][a-z]{2,15})'
const ROLE = ci(
  '(?:owner|co-owner|founder|co-founder|proprietor|president|ceo|principal|owner/designer|owner and designer|owner & designer|master jeweler|head jeweler|designer and owner)',
)

export type NameHow = 'owned_by' | 'name_role' | 'name_is_role' | 'role_name' | 'meet' | 'i_am' | 'i_am_first' | 'jsonld_founder' | 'jsonld_employee' | 'jsonld_author' | 'search_owner' | 'maps_review_owner'

const NAME_RES: [RegExp, NameHow][] = [
  [new RegExp(ci('(?:owned|founded|started|opened|established|operated|run)') + '\\s+(?:' + ci('in') + '\\s+\\d{4}\\s+)?' + ci('by') + '\\s+(?:' + ci('master jeweler') + '\\s+|' + ci('jeweler') + '\\s+|' + ci('goldsmith') + '\\s+)?' + NAMEP, 'g'), 'owned_by'],
  [new RegExp(NAMEP + '\\s*(?:,|-|–|—|\\||\\()\\s*(?:the\\s+|our\\s+|is\\s+the\\s+)?(?:proud\\s+)?' + ROLE + '\\b', 'g'), 'name_role'],
  [new RegExp(NAMEP + '\\s+(?:is|was|has been|became)\\s+(?:the\\s+|our\\s+)?(?:proud\\s+)?(?:second.generation\\s+|third.generation\\s+)?' + ROLE + '\\b', 'g'), 'name_is_role'],
  [new RegExp(ROLE + '\\s*(?:,|:|-|–)?\\s*(?:and\\s+\\w+\\s+)?' + NAMEP, 'g'), 'role_name'],
  [new RegExp(ci('meet') + '\\s+(?:the\\s+owner,?\\s+|our\\s+owner,?\\s+|our\\s+founder,?\\s+|jeweler\\s+)?' + NAMEP, 'g'), 'meet'],
  [new RegExp("(?:I'm|I am|My name is|Hi, I'm|Hello, I'm)\\s+" + NAMEP, 'g'), 'i_am'],
  [new RegExp("(?:I'm|I am|My name is|Hi, I'm|Hello, I'm|Hi! I'm)\\s+" + FIRSTONLY + '\\b', 'g'), 'i_am_first'],
]

/** How much a kind of evidence is worth (enrich.py HOW_RANK). */
export const HOW_RANK: Record<string, number> = {
  owned_by: 3, name_role: 3, name_is_role: 3, role_name: 2, jsonld_founder: 3, meet: 2, maps_review_owner: 3,
  search_owner: 2, i_am: 2, i_am_first: 1, jsonld_employee: 1, jsonld_author: 0,
}

export const BAD_FIRST = new Set(
  ('ruby pearl crystal opal jade amber diamond jewel gold star joy hope faith grace love sterling goldie silver summer autumn sunny ' +
    'precious bliss harmony unique fine custom classic royal bridal estate master mark gem tiffany cartier rolex omega pandora general ' +
    'fort saint san santa grand park christian king prince queen major golden rich price case chase lane ray page will may june april ' +
    'august tag heuer monday sunday van von de la le del lee see read view visit learn find discover browse owners about artist shop best ' +
    'north south east west city new old young jewelry gallery studio design designs store company family team staff owner founder meet ' +
    'our the ross simon verragio tacori gabriel hearts scott kirk noam allison marco alex ani sylvie benchmark').split(' '),
)
const BAD_LAST = new Set(
  ("jewelers jewelry jewellers diamonds designs fine gallery studio company co inc llc gems gold store shop team family and the our " +
    "repair watch watches estate i'm im sr jr owners showroom jewels collection boutique owner").split(' '),
)
const DESIGNER_BRANDS =
  /\b(Simon G|Tacori|Verragio|Gabriel|David Yurman|John Hardy|Kirk Kara|Scott Kay|Alex and Ani|Marco Bicego|Henri Daussi|Ritani|A\.? Jaffe|Sylvie|Christopher Designs|Hearts On Fire|Tag Heuer|Roberto Coin|Mark Patterson|Steven Kirsch|Jeff Cooper|Michael M|Coast Diamond|Martin Flyer|Danhov|Uneek|Parade|Allison Kaufman|Charles Krypell|Frederic Duclos|Elle|Lafonn|Ostbye|Shy Creation|Gumuchian|Judith Ripka|Konstantino|Lagos|Pandora|Kendra Scott|Fope|Ippolita|Penny Preville|Ronald Abram|Frederick Goldman)\b/

/** A person's name? First token must be a known first name; brands and store words rejected. */
export function validName(n: string, firstNames: Set<string>): boolean {
  const parts = n.split(/\s+/)
  const f = parts[0].toLowerCase()
  if (!firstNames.has(f) || BAD_FIRST.has(f)) return false
  if (parts.length > 1 && BAD_LAST.has(parts[parts.length - 1].toLowerCase())) return false
  if (DESIGNER_BRANDS.test(n)) return false
  return true
}

export interface NameHit {
  name: string
  how: NameHow
  ctx: string
}

/** Owner/founder lines in plain text. */
export function namesFromText(text: string, firstNames: Set<string>): NameHit[] {
  const out: NameHit[] = []
  for (const [rx, how] of NAME_RES) {
    rx.lastIndex = 0
    for (const m of text.matchAll(rx)) {
      const n = m[1].trim().replace(/['’]s$/, '').replace(/\s+(?:and|And|&)$/, '')
      if (!validName(n, firstNames)) continue
      const i = m.index ?? 0
      out.push({ name: n, how, ctx: text.slice(Math.max(0, i - 60), i + m[0].length + 60) })
    }
  }
  return out
}

/** founder/employee/author names in JSON-LD blocks. */
export function jsonldNames(html: string, firstNames: Set<string>): NameHit[] {
  const out: NameHit[] = []
  for (const blk of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const m of blk[1].matchAll(/"(founder|founders|employee|author)"\s*:\s*(\{[^{}]*\}|\[[^\]]*\])/g)) {
      for (const nm of m[2].matchAll(/"name"\s*:\s*"([^"]{3,40})"/g)) {
        if (!validName(nm[1], firstNames)) continue
        const how: NameHow = m[1].startsWith('founder') ? 'jsonld_founder' : m[1] === 'employee' ? 'jsonld_employee' : 'jsonld_author'
        out.push({ name: nm[1], how, ctx: m[0].slice(0, 150) })
      }
    }
  }
  return out
}

const ORG_GEN = new Set('jewelry jewelers jewellers fine diamond diamonds gold silver the and of co inc llc company store shop gallery studio designs design coin coins watch watches repair gems boutique ceo'.split(' '))
const PLACES = new Set('texas california nashville santa florida york new chicago houston dallas austin atlanta miami denver seattle portland boston phoenix vegas los angeles san diego francisco ohio georgia carolina virginia michigan arizona colorado oregon washington tennessee'.split(' '))
function otoks(x: string): Set<string> {
  const s = new Set<string>()
  for (const t of x.match(/[A-Za-z'’]{3,}/g) ?? []) {
    const v = t.toLowerCase().replace(/['’]s$/, '').replace(/^['’.]+|['’.]+$/g, '')
    if (!ORG_GEN.has(v)) s.add(v)
  }
  return s
}
const ORG_RX = /(?:owner|founder|co-owner|president|ceo|proprietor)\s*(?:of|at|,)\s+(?:the\s+)?([A-Z][\w'’&.]+(?:\s+(?:[A-Z&][\w'’&.]+|of|and|the)){0,4})|(?:opened|owns|runs|started)\s+(?:the\s+)?([A-Z][\w'’&.]+(?:\s+(?:[A-Z&][\w'’&.]+|of|and|the)){0,4})/g

/**
 * A name whose snippet ties it to a DIFFERENT business ("Kari Smith opened
 * Champaign Jewelers" while researching another store). Returns that other
 * business's name, or '' when the name is not tied elsewhere.
 */
export function otherBusiness(hit: { name: string; ctx: string }, store: string, domain: string): string {
  const i = hit.ctx.indexOf(hit.name.split(' ')[0])
  if (i < 0) return ''
  const win = hit.ctx.slice(Math.max(0, i - 20), i + hit.name.length + 90)
  const stoks = otoks(store)
  stoks.add(domain.split('.')[0])
  const ntoks = otoks(hit.name)
  for (const t of ntoks) if (stoks.has(t)) return ''
  for (const m of win.matchAll(ORG_RX)) {
    const org = m[1] || m[2] || ''
    const ot = otoks(org)
    if (!ot.size || [...ot].some((t) => ntoks.has(t)) || [...ot].every((t) => PLACES.has(t))) continue
    if (![...ot].some((t) => stoks.has(t)) && ![...ot].some((t) => domain.includes(t))) return org
  }
  return ''
}

const NAME_STOP = new Set('ruby pearl crystal opal jade amber diamond jewel gold star joy hope faith grace may june april august sterling silver art love bliss honey sunny merry happy gem rose iris ivory golden royal king queen prince lux luxe bella belle unique custom shop store office hello info mail team fine estate bridal design studio gallery dream'.split(' '))

/** "sarah@store.com" -> "Sarah", "mike.jones@" -> "Mike"; '' when the local part is not a first name. */
export function nameFromLocal(local: string, firstNames: Set<string>): string {
  const m = /^([a-z]{3,12})(?:[._-][a-z]+|[a-z]?)?\d*$/.exec(local.toLowerCase())
  if (!m) return ''
  const f = m[1]
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
  if (firstNames.has(f) && !NAME_STOP.has(f)) return cap(f)
  if (f.length >= 5 && firstNames.has(f.slice(0, -1)) && !NAME_STOP.has(f.slice(0, -1))) return cap(f.slice(0, -1))
  return ''
}

export interface ChosenOwner {
  name: string
  how: NameHow
  evidence_url: string
  confidence: 'high' | 'medium' | 'low'
  score: number
}

/**
 * Pick the owner from all evidence (enrich.py choose_name, simplified): each
 * hit scores its HOW_RANK, +2 when an email on the domain starts with the
 * first name, repeated sightings add up. Confidence: high = an owner/founder
 * line (rank 3) or two independent sources; medium = rank 2; low = the rest.
 */
export function chooseOwner(hits: (NameHit & { url: string })[], emails: string[]): ChosenOwner | null {
  const by = new Map<string, { score: number; best: NameHit & { url: string }; urls: Set<string> }>()
  for (const h of hits) {
    const k = h.name.toLowerCase()
    let w = HOW_RANK[h.how] ?? 1
    const first = h.name.split(' ')[0].toLowerCase()
    if (emails.some((e) => e.split('@')[0].startsWith(first))) w += 2
    const cur = by.get(k)
    if (!cur) by.set(k, { score: w, best: h, urls: new Set([h.url]) })
    else {
      if (!cur.urls.has(h.url)) cur.score += w
      cur.urls.add(h.url)
      if ((HOW_RANK[h.how] ?? 1) > (HOW_RANK[cur.best.how] ?? 1)) cur.best = h
    }
  }
  let top: { score: number; best: NameHit & { url: string }; urls: Set<string> } | null = null
  for (const v of by.values()) if (!top || v.score > top.score) top = v
  if (!top || top.score < 1) return null
  const rank = HOW_RANK[top.best.how] ?? 1
  const confidence = rank >= 3 || top.urls.size >= 2 ? 'high' : rank === 2 ? 'medium' : 'low'
  return { name: top.best.name, how: top.best.how, evidence_url: top.best.url, confidence, score: top.score }
}

// ------------------------------------------------------------------ signals

/** Payment / platform hints visible in a page's HTML. Evidence only, not proof of the processor. */
export function techSignals(html: string): string[] {
  const out: string[] = []
  const add = (k: string, re: RegExp) => {
    if (re.test(html) && !out.includes(k)) out.push(k)
  }
  add('shopify', /cdn\.shopify\.com|Shopify\.theme|myshopify\.com/i)
  add('shopify_payments', /shopify_payments|shop-pay|shopify-payment-button/i)
  add('square', /squareup\.com|square\.site|web\.squarecdn\.com/i)
  add('clover', /clover\.com\/(?:online|pay)|cloverstatic/i)
  add('lightspeed', /lightspeedhq|lsecom|shoplightspeed/i)
  add('stripe', /js\.stripe\.com/i)
  add('woocommerce', /woocommerce/i)
  add('wix', /static\.wixstatic\.com|wix-code/i)
  add('squarespace', /static1\.squarespace\.com/i)
  add('financing', /affirm\.com|synchrony|acima|snapfinance|katapult|progressive leasing|klarna|afterpay/i)
  add('surcharge_wording', /(credit card|card)\s+(surcharge|processing fee|convenience fee)|cash discount|dual pricing/i)
  add('jewelry_platform', /punchmark|gemfind|thinkspace|jewelershowcase|rapnet/i)
  return out
}

/** US phone numbers visible as tel: links. */
export function telLinks(html: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) out.add(m[1].trim())
  return [...out]
}
