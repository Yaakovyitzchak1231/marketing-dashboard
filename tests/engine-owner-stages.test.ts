import { describe, expect, it } from 'vitest'
import {
  reviewNames, filterReviewNames, reviewOwner, reviewsFromSerper, lastNameHits, pickLastName, yelpOwners, yelpTitleMatches,
  learnPattern, facebookPageFromHits, facebookEmails, facebookWalled, mergeOwner,
} from '@/engine/parse/owners'
import { normalizeFindParams, ENGINE_STAGES } from '@/engine/params'
import { toResearchResult } from '@/engine/findLeads'

// Synthetic names and stores only; no real people.
const FIRST = new Set(['ken', 'clint', 'sarah', 'maria', 'david', 'tom', 'anna', 'mike', 'john', 'jane', 'ruby', 'lena'])

describe('maps reviews', () => {
  it('reads customer mentions and owner replies', () => {
    const revs = [
      { snippet: 'Clint, the owner, resized my ring in a day.' },
      { snippet: 'Great service.', response: 'Thank you! This is Clint the owner.' },
      { snippet: 'Ask for Maria, she is so helpful.' },
    ]
    const names = reviewNames(revs, 'Sample Gem Jewelers', FIRST)
    expect(names.map((n) => n.name)).toEqual(['Clint', 'Clint'])
    const o = reviewOwner(revs, 'Sample Gem Jewelers', FIRST)
    expect(o).toMatchObject({ name: 'Clint', confidence: 'high', reviews: 2 })
  })
  it('one review is medium', () => {
    expect(reviewOwner([{ snippet: 'The owner Ken was great' }], 'Sample Gem', FIRST)?.confidence).toBe('medium')
  })
  it('drops late/former owners and relatives, prefers the new owner', () => {
    const revs = [
      { snippet: 'Tom the owner passed away last year, we miss him.' },
      { snippet: 'David, the owner\'s son, helped us.' },
      { snippet: 'Lena the new owner kept the same great quality.' },
      { snippet: 'Anna the owner is kind.' },
    ]
    const kept = filterReviewNames(reviewNames(revs, 'Sample Gem', FIRST)).map((n) => n.name)
    expect(kept).toEqual(['Lena'])
  })
  it('ignores store words and gem-word first names', () => {
    expect(reviewNames([{ snippet: 'Ruby the owner of Ruby Jewelers' }], 'Ruby Jewelers', FIRST)).toEqual([])
  })
  it('parses Serper reviews JSON', () => {
    const r = reviewsFromSerper({ reviews: [{ snippet: 'a', response: { snippet: 'b' } }, { snippet: 'c' }], nextPageToken: 'T' })
    expect(r).toEqual({ reviews: [{ snippet: 'a', response: 'b' }, { snippet: 'c', response: null }], next: 'T' })
    expect(reviewsFromSerper(null)).toEqual({ reviews: [], next: null })
  })
})

describe('firstlast', () => {
  const hits = [
    { title: 'Ken Palmetto - Owner - Sample Gem Jewelers | LinkedIn', link: 'https://www.linkedin.com/in/x', snippet: 'Owner at Sample Gem Jewelers.' },
    { title: 'About us', link: 'https://samplegem.com/about', snippet: 'Ken Palmetto opened the store in 1990.' },
    { title: 'Ken Other - realtor', link: 'https://other.example/k', snippet: 'Ken Other sells houses in Towson.' },
    { title: 'Ken Barrow, owner of Other Diamonds', link: 'https://x.example', snippet: 'Ken Barrow owner of Bright Other Diamonds in Sample Gem town' },
  ]
  it('finds the last name only in snippets about this store', () => {
    const h = lastNameHits(hits, 'Ken', 'Sample Gem Jewelers', 'samplegem.com')
    expect(h.map((x) => x.last)).toContain('Palmetto')
    expect(h.map((x) => x.last)).not.toContain('Other')
    expect(pickLastName(h)?.last).toBe('Palmetto')
  })
  it('needs a role word or the store site', () => {
    expect(pickLastName([{ last: 'Zed', url: 'u', ctx: '', role: false, on_site: false }])).toBeNull()
  })
})

describe('yelp', () => {
  it('only takes owners from the matching listing', () => {
    const hits = [
      { title: 'Sample Gem Jewelers - Towson, MD - Yelp', link: 'https://www.yelp.com/biz/sample-gem-towson', snippet: 'Ken P. Business Owner replied: thanks!' },
      { title: 'Another Store - Towson - Yelp', link: 'https://www.yelp.com/biz/another', snippet: 'Sarah K. Business Owner' },
      { title: 'Sample Gem Jewelers', link: 'https://samplegem.com', snippet: 'Mike R. Business Owner' },
    ]
    expect(yelpOwners(hits, 'Sample Gem Jewelers', FIRST).map((o) => o.name)).toEqual(['Ken'])
    expect(yelpTitleMatches('Gem Sample Co - Yelp', 'Sample Gem Jewelers')).toBe(true)
    expect(yelpTitleMatches('Sample Pearls - Yelp', 'Sample Gem Jewelers')).toBe(false)
  })
})

describe('email pattern', () => {
  const ev = 'https://samplegem.com/team'
  it('first@ pattern', () => {
    expect(learnPattern([{ email: 'sarah@samplegem.com', evidence_url: ev }], 'samplegem.com', 'Ken', null, FIRST)).toMatchObject({
      email: 'ken@samplegem.com', pattern: 'first', learned_from: 'sarah@samplegem.com', same_person: false,
    })
  })
  it('first.last@ needs the owner last name', () => {
    const pub = [{ email: 'sarah.jones@samplegem.com', evidence_url: ev }]
    expect(learnPattern(pub, 'samplegem.com', 'Ken', null, FIRST)).toBeNull()
    expect(learnPattern(pub, 'samplegem.com', 'Ken', 'Palmetto', FIRST)?.email).toBe('ken.palmetto@samplegem.com')
  })
  it('flast from a runner-named address', () => {
    const pub = [{ email: 'sjones@samplegem.com', evidence_url: ev, first_name: 'Sarah', last_name: 'Jones' }]
    expect(learnPattern(pub, 'samplegem.com', 'Ken', 'Palmetto', FIRST)?.email).toBe('kpalmetto@samplegem.com')
  })
  it('the owner\'s own published address is not a guess', () => {
    expect(learnPattern([{ email: 'ken@samplegem.com', evidence_url: ev }], 'samplegem.com', 'Ken', null, FIRST)?.same_person).toBe(true)
  })
  it('ignores role, off-domain and placeholder addresses', () => {
    const pub = [
      { email: 'info@samplegem.com', evidence_url: ev },
      { email: 'sarah@gmail.com', evidence_url: ev },
      { email: 'john.smith@samplegem.com', evidence_url: ev },
      { email: 'first.last@samplegem.com', evidence_url: ev },
    ]
    expect(learnPattern(pub, 'samplegem.com', 'Ken', 'Palmetto', FIRST)).toBeNull()
  })
})

describe('facebook', () => {
  it('picks the store page, not profiles or posts', () => {
    const hits = [
      { title: 'Jane Doe | Facebook', link: 'https://www.facebook.com/profile.php?id=1', snippet: '' },
      { title: 'Sample Gem Jewelers - Posts', link: 'https://www.facebook.com/samplegem/posts/123', snippet: '' },
      { title: 'Sample Gem Jewelers | Towson MD', link: 'https://m.facebook.com/SampleGemJewelers', snippet: '' },
    ]
    expect(facebookPageFromHits(hits, 'Sample Gem Jewelers')).toBe('https://www.facebook.com/SampleGemJewelers')
    expect(facebookPageFromHits([{ title: 'Unrelated', link: 'https://www.facebook.com/unrelated', snippet: '' }], 'Sample Gem Jewelers')).toBeNull()
  })
  it('reads exposed emails and spots walls', () => {
    const html = '<meta property="og:title" content="Sample Gem"><script>{"email":"hello\\u0040samplegem.com","x":"noreply@facebookmail.com"}</script> a@fbcdn.net jsmith@samplegem.com'
    expect(facebookEmails(html)).toEqual(['hello@samplegem.com'])
    expect(facebookWalled('<form id="login_form">You must log in to continue</form>')).toBe(true)
    expect(facebookWalled(html)).toBe(false)
  })
})

describe('merge + build', () => {
  const site = { name: 'Ken', how: 'i_am_first', evidence_url: 'https://samplegem.com/about', confidence: 'low' as const }
  it('reviews corroborate a weak site name to high', () => {
    const m = mergeOwner(site, { review: { name: 'Ken', confidence: 'medium', reviews: 1, ctx: '', url: 'https://maps.google.com/?cid=1' } })
    expect(m).toMatchObject({ name: 'Ken', confidence: 'high', evidence_url: 'https://samplegem.com/about' })
  })
  it('a stronger review name replaces a low one; nothing -> null', () => {
    const m = mergeOwner(site, { review: { name: 'Anna', confidence: 'high', reviews: 3, ctx: '', url: 'https://maps.google.com/?cid=1' } })
    expect(m?.name).toBe('Anna')
    expect(mergeOwner(null, {})).toBeNull()
  })
  it('toResearchResult: last name fact, facebook email, guessed pattern email held', () => {
    const crawl = {
      site_ok: true, blocked: false, final_url: 'https://samplegem.com', pages: [{ url: 'https://samplegem.com', status: 200 }],
      emails: [{ email: 'sarah@samplegem.com', evidence_url: 'https://samplegem.com/team', how: 'mailto' }], offsite_emails: [],
      names: [{ name: 'Ken', how: 'name_role', url: 'https://samplegem.com/about', ctx: 'Ken, owner' }], owner: null, phones: [], signals: [],
    }
    const r = toResearchResult(1, 'engine', crawl as never, null, 'samplegem.com', 'ok', {
      last: { last: 'Palmetto', url: 'https://samplegem.com/about', ctx: '' },
      facebook: { page: 'https://www.facebook.com/SampleGem', emails: ['shop.samplegem@gmail.com'] },
      pattern: { email: 'ken.palmetto@samplegem.com', pattern: 'first.last', learned_from: 'sarah@samplegem.com', evidence_url: 'https://samplegem.com/team', same_person: false },
    })
    expect(r.people[0]).toMatchObject({ name: 'Ken Palmetto', confidence: 'high' })
    expect(r.facts.find((f) => f.field === 'owner_last_name')).toMatchObject({ value: 'Palmetto', confidence: 'medium' })
    expect(r.emails.find((e) => e.how === 'facebook')?.evidence_url).toBe('https://www.facebook.com/SampleGem')
    expect(r.emails.find((e) => e.email === 'ken.palmetto@samplegem.com')).toMatchObject({ guessed: true, first_name: 'Ken', last_name: 'Palmetto' })
  })
})

describe('params', () => {
  it('extra stages are opt-in', () => {
    expect(normalizeFindParams({ states: 'MD' }).stages).toEqual(ENGINE_STAGES)
    expect(normalizeFindParams({ states: 'MD', stages: ['build', 'pattern', 'discover', 'reviews', 'bogus'] }).stages).toEqual(['discover', 'reviews', 'pattern', 'build'])
  })
})
