import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { cancelFindJob, createFindJob, enqueueResearch, getFindJob, listFindJobs, measuredEta, type FindJob } from '@/lib/engine/jobs'
import { upsertCompany } from '@/lib/research/companies'
import { claimTask } from '@/lib/ops/core'
import { ParamsError } from '@/engine/params'
import { parseWhere } from '@/components/find/FindForm'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('find jobs', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it('creates a find_leads task assigned to Tab with validated params, lists and cancels it', async () => {
    const job = await createFindJob(db, 'owner', { segment: 'jeweler', states: ['md'], max_businesses: 40 })
    expect(job).toMatchObject({ status: 'queued', assigned_to: 'tab', created_by: 'owner', title: 'Find 40 jewelers in MD', run: null })
    expect(job.params.queries).toHaveLength(7)
    await expect(createFindJob(db, 'owner', { states: [] })).rejects.toBeInstanceOf(ParamsError)
    expect((await listFindJobs(db)).map((j) => j.id)).toEqual([job.id])
    const ev = await db.query<{ summary: string }>("select summary from lp.events where kind = 'task.created'")
    expect(ev.rows[0].summary).toMatch(/assigned "Find 40 jewelers in MD" to Tab/)
    const c = await cancelFindJob(db, 'owner', job.id)
    expect(c?.status).toBe('cancelled')
    await expect(cancelFindJob(db, 'owner', job.id)).rejects.toThrow(/already cancelled/)
    expect(await getFindJob(db, 999)).toBeNull()
  })

  it('a cancelled job cannot be claimed', async () => {
    const job = await createFindJob(db, 'owner', { states: ['VA'], max_businesses: 5 })
    await cancelFindJob(db, 'owner', job.id)
    expect(await claimTask(db, 'tab', { kinds: ['find_leads'] })).toBeNull()
  })

  it('queues one research task per company and reports duplicates and unknown ids', async () => {
    const a = await db.tx((q) => upsertCompany(q, { name: 'Gem Co', website: 'gemco.test' }, 'owner'), 'owner')
    const b = await db.tx((q) => upsertCompany(q, { name: 'Ring Studio', website: 'ring.test' }, 'owner'), 'owner')
    const r1 = await enqueueResearch(db, 'owner', [a.id, b.id, 99999])
    expect(r1.queued.map((x) => x.company_id)).toEqual([a.id, b.id])
    expect(r1.missing).toEqual([99999])
    const r2 = await enqueueResearch(db, 'owner', [a.id])
    expect(r2).toMatchObject({ queued: [], already: [a.id] })
    const st = await db.query<{ research_status: string }>('select research_status from lp.companies where id = $1', [a.id])
    expect(st.rows[0].research_status).toBe('queued')
    const t = await db.query<{ kind: string; assigned_to: string; dedupe_key: string; payload: { website: string } }>('select kind, assigned_to, dedupe_key, payload from lp.tasks where company_id = $1', [a.id])
    expect(t.rows[0]).toMatchObject({ kind: 'research_company', assigned_to: 'tab', dedupe_key: `research:${a.id}`, payload: { website: 'gemco.test' } })
  })
})

describe('measured ETA', () => {
  const base = (over: Partial<NonNullable<FindJob['run']>>): FindJob =>
    ({
      id: 1, title: 't', status: 'running', assigned_to: 'tab', claimed_by: 'tab', created_by: 'owner', created_at: '', heartbeat_at: null, finished_at: null,
      error: null, report: null, params: {} as FindJob['params'],
      run: { id: 1, status: 'running', stage: 'crawl', counters: {}, notes: [], started_at: '', heartbeat_at: null, error: null, ...over },
    }) as FindJob
  it('only from this run\'s own pace, after 5 items', () => {
    const now = Date.parse('2026-10-08T18:10:00Z')
    const started = '2026-10-08T18:00:00Z'
    expect(measuredEta(base({ counters: { stage_started_at: started, kept: 100, crawled: 4 } }), now)).toBeNull()
    expect(measuredEta(base({ counters: { stage_started_at: started, kept: 100, crawled: 50 } }), now)).toEqual({ seconds: 600, basis: '50 done in 600 s this stage' })
    expect(measuredEta(base({ stage: 'discover', counters: { stage_started_at: started, kept: 100 } }), now)).toBeNull()
  })
})

describe('where box', () => {
  it('reads states and cities', () => {
    expect(parseWhere('md, va')).toEqual({ states: ['MD', 'VA'], cities: [] })
    expect(parseWhere('Towson, MD; Columbia, md')).toEqual({ states: [], cities: ['Towson, MD', 'Columbia, MD'] })
  })
})
