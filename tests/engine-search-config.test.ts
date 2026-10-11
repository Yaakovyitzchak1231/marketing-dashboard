import { describe, expect, it } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { createCampaign } from '@/lib/campaigns/store'
import { resolveCampaignSearchConfig } from '@/engine/searchConfig'
import { normalizeFindParams } from '@/engine/params'
import { classifyPlace } from '@/engine/parse/filter'
import { createFindJob } from '@/lib/engine/jobs'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function addItem(db: TestDb, campaignId: number, kind: string, name: string, status = 'approved', value: string | null = null) {
  await db.query(
    `insert into lp.campaign_profile_items (campaign_id, kind, name, value, status) values ($1, $2, $3, $4, $5)`,
    [campaignId, kind, name, value, status],
  )
}

describe('engine search config resolution (campaign-agnostic find-leads)', () => {
  it('falls back to the pool\'s built-in default when the campaign has no approved profile items, and logs it', async () => {
    const db: TestDb = await createTestDb()
    try {
      const c = await createCampaign(db, 'owner', { name: 'Fresh jeweler campaign', pool: 'jeweler' })
      const resolved = await resolveCampaignSearchConfig(db, c.id)
      expect(resolved.source).toBe('built-in default for pool jeweler')
      expect(resolved.config.search_phrases).toContain('jewelry store')
      expect(resolved.campaign_id).toBe(c.id)
    } finally {
      await db.close()
    }
  })

  it('a brand-new pool with no built-in default resolves to an honest empty config', async () => {
    const db: TestDb = await createTestDb()
    try {
      const c = await createCampaign(db, 'owner', { name: 'Dental pilot', pool: 'other' })
      const resolved = await resolveCampaignSearchConfig(db, c.id)
      expect(resolved.source).toBe('built-in default for pool other')
      expect(resolved.config.search_phrases).toEqual([])
    } finally {
      await db.close()
    }
  })

  it('APPROVED profile items win over the pool\'s built-in default; only approved status counts', async () => {
    const db: TestDb = await createTestDb()
    try {
      const c = await createCampaign(db, 'owner', { name: 'Dental pilot 2', pool: 'other' })
      await addItem(db, c.id, 'search_phrase', 'dental clinic near me', 'approved')
      await addItem(db, c.id, 'search_phrase', 'orthodontist', 'suggested') // not approved -> excluded
      await addItem(db, c.id, 'place_category', 'Dentist', 'approved')
      await addItem(db, c.id, 'negative_keyword', 'cosmetic only', 'approved')
      const resolved = await resolveCampaignSearchConfig(db, c.id)
      expect(resolved.source).toBe('profile')
      expect(resolved.config.search_phrases).toEqual(['dental clinic near me'])
      expect(resolved.config.place_categories).toEqual(['Dentist'])
      expect(resolved.config.negative_keywords).toEqual(['cosmetic only'])
    } finally {
      await db.close()
    }
  })

  it('normalizeFindParams carries the resolved config through and createFindJob persists it on the job', async () => {
    const db: TestDb = await createTestDb()
    try {
      const c = await createCampaign(db, 'owner', { name: 'Restaurants', pool: 'other' })
      await addItem(db, c.id, 'search_phrase', 'family restaurant', 'approved')
      const job = await createFindJob(db, 'owner', { campaign_id: c.id, states: ['MD'], max_businesses: 5 })
      expect(job.params.config_source).toBe('profile')
      expect(job.params.queries).toEqual(['family restaurant'])
      expect(job.params.campaign_id).toBe(c.id)
      // Re-normalizing the stored payload (what the runner does) keeps the same resolved config.
      const reNormalized = normalizeFindParams(job.params as unknown as Record<string, unknown>)
      expect(reNormalized.config_source).toBe('profile')
      expect(reNormalized.search_phrases).toEqual(['family restaurant'])
    } finally {
      await db.close()
    }
  })

  it('a run with no campaign_id keeps today\'s behavior: explicit queries, else the pool default', () => {
    const p1 = normalizeFindParams({ states: ['MD'], queries: ['custom search'] })
    expect(p1.queries).toEqual(['custom search'])
    expect(p1.config_source).toMatch(/built-in default/)
    const p2 = normalizeFindParams({ states: ['MD'], segment: 'ai_agency' })
    expect(p2.queries[0]).toBe('AI automation agency')
  })

  it('classifyPlace: negative keywords exclude a place for any pool, including the two curated ones', () => {
    const base = mkPlaceObj({ name: 'Gem Co', website: 'https://gemco.com', categories: ['Jewelry store'], address: '1 Main St, Towson, MD 21204' })
    expect(classifyPlace(base, 'jeweler', { config: { negative_keywords: ['gem co'] } })).toMatchObject({ keep: false, reason: 'excluded_by_negative_keyword' })
    expect(classifyPlace(base, 'jeweler')).toMatchObject({ keep: true })
  })

  it('classifyPlace: a campaign-agnostic pool with no curated heuristics is gated purely by the campaign\'s place categories', () => {
    const dental = mkPlaceObj({ name: 'Smile Dental', website: 'https://smiledental.com', categories: ['Dentist'], address: '1 Main St, Towson, MD 21204' })
    const other = mkPlaceObj({ name: 'Random Shop', website: 'https://randomshop.com', categories: ['Gift shop'], address: '1 Main St, Towson, MD 21204' })
    const config = { place_categories: ['Dentist', 'Dental clinic'] }
    expect(classifyPlace(dental, 'dental_clinics', { config })).toMatchObject({ keep: true })
    expect(classifyPlace(other, 'dental_clinics', { config })).toMatchObject({ keep: false, reason: 'not_in_campaign_categories' })
    // No categories configured at all: accept anything that has at least one Maps category.
    expect(classifyPlace(other, 'dental_clinics', { config: { place_categories: [] } })).toMatchObject({ keep: true })
  })
})

function mkPlaceObj(o: Partial<{ name: string; website: string | null; phone: string | null; address: string | null; categories: string[]; lat: number | null; lng: number | null; city: string | null; state: string | null; rating: number | null; reviews: number | null; place_id: string | null; cid: string | null }>) {
  return { name: 'X', website: null, phone: null, address: null, categories: [], lat: null, lng: null, city: null, state: null, rating: null, reviews: null, place_id: null, cid: null, ...o }
}
