import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))

import { createTestDb } from './helpers/pglite-db'
import { checklistComplete, evaluateChecklist, readChecklistInputs, type ChecklistInputs } from '@/lib/setup/checklist'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

const EMPTY: ChecklistInputs = {
  instantlyConnected: false,
  webhookReceivingRecently: false,
  agentKeysAdded: false,
  leadsImported: false,
  campaignProfileReviewed: false,
  segmentsTableExists: false,
  firstSegmentCreated: false,
}

describe('evaluateChecklist (pure)', () => {
  it('empty state: everything open except the coming-soon journey item', () => {
    const items = evaluateChecklist(EMPTY)
    const journey = items.find((i) => i.id === 'journey')
    expect(journey?.status).toBe('coming_soon')
    expect(items.filter((i) => i.id !== 'journey').every((i) => i.status === 'open')).toBe(true)
    expect(checklistComplete(items)).toBe(false)
  })

  it('partial state: only the done items tick', () => {
    const items = evaluateChecklist({ ...EMPTY, instantlyConnected: true, leadsImported: true })
    expect(items.find((i) => i.id === 'instantly')?.status).toBe('done')
    expect(items.find((i) => i.id === 'leads')?.status).toBe('done')
    expect(items.find((i) => i.id === 'webhook')?.status).toBe('open')
    expect(checklistComplete(items)).toBe(false)
  })

  it('a missing segments table reads as open, not a crash or a different state', () => {
    const items = evaluateChecklist({ ...EMPTY, segmentsTableExists: false, firstSegmentCreated: false })
    expect(items.find((i) => i.id === 'segment')?.status).toBe('open')
  })

  it('segmentsTableExists but no segment created yet is still open', () => {
    const items = evaluateChecklist({ ...EMPTY, segmentsTableExists: true, firstSegmentCreated: false })
    expect(items.find((i) => i.id === 'segment')?.status).toBe('open')
  })

  it('complete state: everything done is "complete" even though journey is only coming-soon', () => {
    const items = evaluateChecklist({
      instantlyConnected: true,
      webhookReceivingRecently: true,
      agentKeysAdded: true,
      leadsImported: true,
      campaignProfileReviewed: true,
      segmentsTableExists: true,
      firstSegmentCreated: true,
    })
    expect(checklistComplete(items)).toBe(true)
    expect(items.find((i) => i.id === 'journey')?.status).toBe('coming_soon')
  })
})

describe('readChecklistInputs (real Postgres via PGlite)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => {
    await db.close()
  })

  it('reads all-false on a freshly migrated, empty database', async () => {
    const inputs = await readChecklistInputs(db)
    expect(inputs.instantlyConnected).toBe(false)
    expect(inputs.leadsImported).toBe(false)
    expect(inputs.campaignProfileReviewed).toBe(false)
    // lp.segments does not exist until its own migration (plan 2.1) runs.
    expect(inputs.segmentsTableExists).toBe(false)
    expect(inputs.firstSegmentCreated).toBe(false)
  })

  it('returns the all-false shape with no database at all', async () => {
    const inputs = await readChecklistInputs(null)
    expect(inputs).toEqual({
      instantlyConnected: false,
      webhookReceivingRecently: false,
      agentKeysAdded: false,
      leadsImported: false,
      campaignProfileReviewed: false,
      segmentsTableExists: false,
      firstSegmentCreated: false,
    })
  })

  it('leadsImported flips true once a company exists', async () => {
    await db.query(`insert into lp.companies (name) values ('Acme Co')`)
    const inputs = await readChecklistInputs(db)
    expect(inputs.leadsImported).toBe(true)
  })
})
