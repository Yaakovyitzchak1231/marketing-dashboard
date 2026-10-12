import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { emitLeadEvent } from '@/lib/events/emit'
import { runOp } from '@/lib/ops/dispatch'
import { runDueJourneys } from '@/lib/journeys/runner'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('wait and drop if replied (plan 3.4)', () => {
  let db: TestDb
  let co: number

  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Wait Co', domain: 'wait.example', city: 'Towson' })
  })
  afterAll(async () => db.close())

  it('drops the run when a reply lands during the wait', async () => {
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Drop on reply' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: { start: 'hold', nodes: [{ id: 'hold', kind: 'wait', config: { days: 3, drop_if_replied: true }, next: 'done' }, { id: 'done', kind: 'note' }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { results: { run_id: number }[] }
    const runId = en.results[0].run_id
    await runDueJourneys(db)
    await emitLeadEvent(db, { type: 'reply_received', company_id: co, source: 'test' })
    await runDueJourneys(db, { now: new Date(Date.now() + 60_000) })
    const { rows } = await db.query<{ status: string }>(
      'select status from lp.journey_runs where id = $1',
      [runId],
    )
    expect(rows[0].status).toBe('exited')
  })

  it('waits until an absolute time when no reply arrives', async () => {
    const until = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Until slot' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: { start: 'hold', nodes: [{ id: 'hold', kind: 'wait', config: { until }, next: 'done' }, { id: 'done', kind: 'note' }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { results: { run_id: number }[] }
    await runDueJourneys(db)
    const early = await db.query<{ status: string }>('select status from lp.journey_runs where id = $1', [en.results[0].run_id])
    expect(early.rows[0].status).toBe('waiting')
    await runDueJourneys(db, { now: new Date(Date.now() + 3 * 60 * 60 * 1000) })
    const late = await db.query<{ status: string }>('select status from lp.journey_runs where id = $1', [en.results[0].run_id])
    expect(late.rows[0].status).toBe('done')
  })
})
