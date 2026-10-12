/**
 * Oct 6 regression test (sheet row 1.18): the pools / find-leads engine
 * un-hard-coding must not change what the Oct 6 jeweler run did, and the new
 * campaign-agnostic paths must work for pools that never had curated rules.
 *
 * - jeweler + ai_agency filter behavior is pinned to the Oct 6 rules (now
 *   data in engine/data/pool-heuristics.ts, not branches in the filter).
 * - params.ts has no hard-coded pool defaults: an explicit segment (or the
 *   campaign's pool) is required, and queries fall back to the pool's own
 *   built-in default set, not a per-pool branch.
 * - every find_leads task gets a row in lp.find_jobs (migration 0054).
 */
import { describe, expect, it } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { createCampaign } from '@/lib/campaigns/store'
import { createFindJob } from '@/lib/engine/jobs'
import { getFindJobRecord, markFindJob, recordFindJob } from '@/engine/findJobRecord'
import { normalizeFindParams, findJobTitle, ParamsError, JEWELER_QUERIES } from '@/engine/params'
import { resolveCampaignSearchConfig } from '@/engine/searchConfig'
import { classifyPlace } from '@/engine/parse/filter'
import { heuristicsFor } from '@/engine/data/pool-heuristics'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

function mkPlace(o: Partial<{ name: string; website: string | null; categories: string[]; address: string }>) {
  return {
    name: 'X', website: null, phone: null, address: null, categories: [], lat: null, lng: null,
    city: null, state: null, rating: null, reviews: null, place_id: null, cid: null, ...o,
  }
}

describe('Oct 6 regression: jeweler filter rules are unchanged', () => {
  it('keeps a real independent jeweler', () => {
    const r = classifyPlace(
      mkPlace({ name: 'Smith & Sons Fine Jewelers', website: 'https://smithsonsjewelers.com', categories: ['Jewelry store'], address: '1 Main St, Towson, MD 21204' }),
      'jeweler',
    )
    expect(r).toMatchObject({ keep: true, domain: 'smithsonsjewelers.com', city: 'Towson', state: 'MD' })
  })

  it('drops chains by name and by domain', () => {
    const byName = classifyPlace(
      mkPlace({ name: 'Kay Jewelers', website: 'https://somekaysite.com', categories: ['Jewelry store'], address: '1 Main St, Towson, MD 21204' }),
      'jeweler',
    )
    expect(byName).toMatchObject({ keep: false, reason: 'chain_or_nonjeweler_name' })
    const byDomain = classifyPlace(
      mkPlace({ name: 'Fine Jewelry Outlet', website: 'https://kay.com', categories: ['Jewelry store'], address: '1 Main St, Towson, MD 21204' }),
      'jeweler',
    )
    expect(byDomain).toMatchObject({ keep: false, reason: 'chain_domain' })
  })

  it('drops pawn / buyer primaries and non-jeweler categories', () => {
    // 'Pawn' in the name trips the chain-name check first (original behavior);
    // the pawn-primary rule is for a jeweler-named store whose Maps primary is a pawn shop.
    const pawnName = classifyPlace(
      mkPlace({ name: 'Cash Pawn', website: 'https://cashpawn.com', categories: ['Pawn shop', 'Jewelry store'], address: '1 Main St, Towson, MD 21204' }),
      'jeweler',
    )
    expect(pawnName).toMatchObject({ keep: false, reason: 'chain_or_nonjeweler_name' })
    const pawn = classifyPlace(
      mkPlace({ name: 'Smith & Sons', website: 'https://smithsons.com', categories: ['Pawn shop', 'Jewelry store'], address: '1 Main St, Towson, MD 21204' }),
      'jeweler',
    )
    expect(pawn).toMatchObject({ keep: false, reason: 'pawn_buyer_or_other_primary' })
    const notJeweler = classifyPlace(
      mkPlace({ name: 'Flower Shop', website: 'https://flowers.com', categories: ['Florist'], address: '1 Main St, Towson, MD 21204' }),
      'jeweler',
    )
    expect(notJeweler).toMatchObject({ keep: false, reason: 'not_jeweler_category' })
  })

  it('keeps a jeweler-named store under an unlisted primary, drops a gift shop', () => {
    // The name fallback only runs when the categories already read as jewelry
    // but the primary is not in the allowed list.
    const rescued = classifyPlace(
      mkPlace({ name: 'Smith Jewelers', website: 'https://smithjewelers.com', categories: ['Store', 'Jewelry store'], address: '1 Main St, Towson, MD 21204' }),
      'jeweler',
    )
    expect(rescued.keep).toBe(true)
    const dropped = classifyPlace(
      mkPlace({ name: 'Smith Gifts', website: 'https://smithgifts.com', categories: ['Store', 'Jewelry store'], address: '1 Main St, Towson, MD 21204' }),
      'jeweler',
    )
    expect(dropped).toMatchObject({ keep: false, reason: 'primary_category_not_jeweler' })
  })

  it('still drops chains when the caller does not require category data', () => {
    const r = classifyPlace(
      mkPlace({ name: 'Zales', website: 'https://zales.com', categories: [], address: '1 Main St, Towson, MD 21204' }),
      'jeweler',
      { requireCategory: false },
    )
    expect(r).toMatchObject({ keep: false, reason: 'chain_or_nonjeweler_name' })
  })

  it('ai_agency rules are unchanged: keeps agencies, drops staffing primaries', () => {
    const keep = classifyPlace(
      mkPlace({ name: 'Acme AI Studio', website: 'https://acmeai.com', categories: ['Software company'], address: '1 Main St, Towson, MD 21204' }),
      'ai_agency',
    )
    expect(keep.keep).toBe(true)
    const staffing = classifyPlace(
      mkPlace({ name: 'HireFast', website: 'https://hirefast.com', categories: ['Employment agency', 'Software company'], address: '1 Main St, Towson, MD 21204' }),
      'ai_agency',
    )
    expect(staffing).toMatchObject({ keep: false, reason: 'not_agency_primary' })
    const repair = classifyPlace(
      mkPlace({ name: 'FixIt Computers', website: 'https://fixit.com', categories: ['Computer repair'], address: '1 Main St, Towson, MD 21204' }),
      'ai_agency',
    )
    expect(repair).toMatchObject({ keep: false, reason: 'not_agency_category' })
  })
})

describe('Oct 6 regression: pools without curated heuristics stay generic', () => {
  it('a pool with no registry entry is gated purely by the campaign categories', () => {
    expect(heuristicsFor('jeweler')).toBeDefined()
    expect(heuristicsFor('ai_agency')).toBeDefined()
    expect(heuristicsFor('dental_clinics')).toBeUndefined()
    const dental = mkPlace({ name: 'Smile Dental', website: 'https://smiledental.com', categories: ['Dentist'], address: '1 Main St, Towson, MD 21204' })
    const other = mkPlace({ name: 'Random Shop', website: 'https://randomshop.com', categories: ['Gift shop'], address: '1 Main St, Towson, MD 21204' })
    const config = { place_categories: ['Dentist'] }
    expect(classifyPlace(dental, 'dental_clinics', { config })).toMatchObject({ keep: true })
    expect(classifyPlace(other, 'dental_clinics', { config })).toMatchObject({ keep: false, reason: 'not_in_campaign_categories' })
  })

  it('negative keywords exclude a place for any pool, including the curated ones', () => {
    const base = mkPlace({ name: 'Gem Co', website: 'https://gemco.com', categories: ['Jewelry store'], address: '1 Main St, Towson, MD 21204' })
    expect(classifyPlace(base, 'jeweler', { config: { negative_keywords: ['gem co'] } })).toMatchObject({
      keep: false, reason: 'excluded_by_negative_keyword',
    })
    expect(classifyPlace(base, 'jeweler')).toMatchObject({ keep: true })
  })
})

describe('Oct 6 regression: params have no hard-coded pool defaults', () => {
  it('an ad hoc run must name its pool — there is no jeweler default anymore', () => {
    expect(() => normalizeFindParams({ states: ['MD'], queries: ['custom search'] })).toThrow(ParamsError)
    expect(() => normalizeFindParams({ states: ['MD'], queries: ['custom search'] })).toThrow(/pick a pool/)
  })

  it('a campaign run reads the campaign\u2019s pool when no segment is given', async () => {
    const db: TestDb = await createTestDb()
    try {
      const c = await createCampaign(db, 'owner', { name: 'Dental pilot', pool: 'other' })
      const resolved = await resolveCampaignSearchConfig(db, c.id)
      expect(resolved.pool).toBe('other')
      const p = normalizeFindParams({ states: ['MD'], queries: ['family restaurant'] }, resolved)
      expect(p.segment).toBe('other')
      expect(p.campaign_id).toBe(c.id)
    } finally {
      await db.close()
    }
  })

  it('queries fall back to the pool\u2019s own built-in default set, not a per-pool branch', () => {
    const jeweler = normalizeFindParams({ segment: 'jeweler', states: ['MD'] })
    expect(jeweler.queries).toEqual(JEWELER_QUERIES)
    // A pool with no built-in default and no queries is an honest error, not an empty run.
    expect(() => normalizeFindParams({ segment: 'other', states: ['MD'] })).toThrow(/no searches/)
    const explicit = normalizeFindParams({ segment: 'other', states: ['MD'], queries: ['x', 'y'] })
    expect(explicit.queries).toEqual(['x', 'y'])
  })

  it('findJobTitle uses the pool\u2019s label from lp.pools, never a hard-coded name', () => {
    const p = normalizeFindParams({ segment: 'dental_clinics', states: ['MD'], max_businesses: 5, queries: ['dentist'] })
    expect(findJobTitle(p, 'Dental clinics')).toBe('Find 5 Dental clinics in MD')
    expect(findJobTitle(p)).toBe('Find 5 dental clinics in MD')
  })
})

describe('Oct 6 regression: lp.find_jobs (migration 0054)', () => {
  it('createFindJob writes a find_jobs row keyed to the pool, and rejects an unknown pool', async () => {
    const db: TestDb = await createTestDb()
    try {
      const job = await createFindJob(db, 'owner', { segment: 'jeweler', states: ['MD'], max_businesses: 5 })
      expect(job.title).toBe('Find 5 Jewelers in MD')
      const rec = await getFindJobRecord<{ pool: string; status: string; config_source: string; params: { segment: string } }>(db, job.id)
      expect(rec).toMatchObject({ pool: 'jeweler', status: 'pending', config_source: 'built-in default for pool jeweler' })
      expect(rec?.params.segment).toBe('jeweler')
      await expect(createFindJob(db, 'owner', { segment: 'not_a_pool', states: ['MD'], queries: ['x'] })).rejects.toThrow(
        /No pool "not_a_pool". Create it in Settings > Pools first/,
      )
      await expect(createFindJob(db, 'owner', { segment: 'not_a_pool', states: ['MD'], queries: ['x'] })).rejects.toBeInstanceOf(OpsError)
    } finally {
      await db.close()
    }
  })

  it('recordFindJob / markFindJob track the run lifecycle', async () => {
    const db: TestDb = await createTestDb()
    try {
      const { rows } = await db.query<{ id: number }>(
        `insert into lp.tasks (kind, title, status) values ('find_leads', 't', 'queued') returning id`,
      )
      const taskId = rows[0].id
      await recordFindJob(db, { task_id: taskId, campaign_id: null, pool: 'jeweler', title: 't', params: {}, config_source: 'profile', created_by: 'owner' })
      // Idempotent re-record (the CLI and the dashboard both record).
      await recordFindJob(db, { task_id: taskId, campaign_id: null, pool: 'jeweler', title: 't2', params: {}, config_source: 'profile', created_by: 'owner' })
      await markFindJob(db, taskId, { status: 'running' })
      const running = await getFindJobRecord<Record<string, unknown>>(db, taskId)
      expect(running).toMatchObject({ status: 'running', title: 't2' })
      expect(running?.started_at).toBeTruthy()
      expect(running?.finished_at).toBeNull()
      await markFindJob(db, taskId, { status: 'done', counters: { kept: 3 }, report: 'done' })
      const done = await getFindJobRecord<Record<string, unknown>>(db, taskId)
      expect(done).toMatchObject({ status: 'done', counters: { kept: 3 }, report: 'done' })
      expect(done?.finished_at).toBeTruthy()
    } finally {
      await db.close()
    }
  })
})
