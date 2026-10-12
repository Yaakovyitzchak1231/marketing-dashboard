import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { emitLeadEvent } from '@/lib/events/emit'
import { runOp } from '@/lib/ops/dispatch'
import { runDueJourneys } from '@/lib/journeys/runner'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('goals, go-to, exit, entry cap (plan 3.7)', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  async function company(name: string, domain: string) {
    return addCompany(db, { name, domain, city: 'Towson' })
  }

  async function statusOf(runId: number) {
    const { rows } = await db.query<{ status: string; node_id: string }>(
      'select status, node_id from lp.journey_runs where id = $1',
      [runId],
    )
    return rows[0]
  }

  it('a goal node finishes the run as goal', async () => {
    const co = await company('Goal Co', 'goal.example')
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Goal' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: { start: 'win', nodes: [{ id: 'win', kind: 'goal' }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { results: { run_id: number }[] }
    await runDueJourneys(db)
    expect(await statusOf(en.results[0].run_id)).toMatchObject({ status: 'goal', node_id: 'win' })
  })

  it('goto jumps to the named node', async () => {
    const co = await company('Jump Co', 'jump.example')
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Jump' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: {
        start: 'hop',
        nodes: [
          { id: 'hop', kind: 'goto', config: { to: 'landed' } },
          { id: 'landed', kind: 'note' },
        ],
      },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { results: { run_id: number }[] }
    await runDueJourneys(db)
    expect(await statusOf(en.results[0].run_id)).toMatchObject({ status: 'done', node_id: 'landed' })
  })

  it('exit_event on the journey goal takes the run out', async () => {
    const co = await company('Exit Co', 'exit.example')
    const j = await runOp(db, 'owner', 'journey_upsert', {
      name: 'Exit if unsubscribed', goal: { exit_event: 'lead_unsubscribed' },
    }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: { start: 'hold', nodes: [{ id: 'hold', kind: 'wait', config: { days: 3 } }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { results: { run_id: number }[] }
    const runId = en.results[0].run_id
    await runDueJourneys(db)
    await emitLeadEvent(db, { type: 'lead_unsubscribed', company_id: co, source: 'test' })
    await runDueJourneys(db, { now: new Date(Date.now() + 60_000) })
    expect((await statusOf(runId)).status).toBe('exited')
  })

  it('entry_cap blocks another pass after the cap', async () => {
    const co = await company('Cap Co', 'cap.example')
    const j = await runOp(db, 'owner', 'journey_upsert', {
      name: 'Twice', entry_mode: 'multiple', settings: { entry_cap: 2 },
    }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: { start: 'n', nodes: [{ id: 'n', kind: 'exit', config: { reason: 'done' } }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const first = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { enrolled: number }
    await runDueJourneys(db)
    const second = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { enrolled: number }
    await runDueJourneys(db)
    const third = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { enrolled: number; results: { reason?: string }[] }
    expect(first.enrolled).toBe(1)
    expect(second.enrolled).toBe(1)
    expect(third.enrolled).toBe(0)
  })
})
