import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { emitLeadEvent } from '@/lib/events/emit'
import { runOp } from '@/lib/ops/dispatch'
import { scanDueTriggers } from '@/lib/triggers/match'
import { runDueJourneys } from '@/lib/journeys/runner'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('delayed trigger (plan 3.3)', () => {
  let db: TestDb
  let co: number

  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Delay Co', domain: 'delay.example', city: 'Towson' })
  })
  afterAll(async () => db.close())

  it('fires N days after X, once, and not before the delay', async () => {
    const saved = await runOp(db, 'owner', 'upsert_trigger', {
      name: '3 days after sent unless replied',
      kind: 'delayed',
      config: { after_event: 'email_sent', days: 3, unless_event: 'reply_received' },
    }) as { id: number }
    await emitLeadEvent(db, { type: 'email_sent', company_id: co, source: 'test' })
    const early = await scanDueTriggers(db, new Date())
    expect(early.delayed).toBe(0)
    const later = await scanDueTriggers(db, new Date(Date.now() + 4 * 24 * 60 * 60 * 1000))
    expect(later.delayed).toBe(1)
    const again = await scanDueTriggers(db, new Date(Date.now() + 5 * 24 * 60 * 60 * 1000))
    expect(again.delayed).toBe(0)
    const { rows } = await db.query<{ payload: { cancel_on?: string[] } }>(
      'select payload from lp.trigger_fires where trigger_id = $1',
      [saved.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].payload.cancel_on).toEqual(['reply_received'])
  })

  it('Y before the delay cancels the fire', async () => {
    const saved = await runOp(db, 'owner', 'upsert_trigger', {
      name: '2 days after click unless unsubscribed',
      kind: 'delayed',
      config: { after_event: 'email_link_clicked', days: 2, unless_events: ['lead_unsubscribed'] },
    }) as { id: number }
    await emitLeadEvent(db, { type: 'email_link_clicked', company_id: co, source: 'test' })
    await emitLeadEvent(db, { type: 'lead_unsubscribed', company_id: co, source: 'test' })
    const scanned = await scanDueTriggers(db, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000))
    expect(scanned.delayed).toBe(0)
    const { rows } = await db.query<{ status: string }>(
      'select status from lp.trigger_delays where trigger_id = $1',
      [saved.id],
    )
    expect(rows.map((r) => r.status)).toEqual(['cancelled'])
  })

  it('enrols a live journey and copies cancel_on onto the run', async () => {
    const trigger = await runOp(db, 'owner', 'upsert_trigger', {
      name: '1 day after custom unless meeting',
      kind: 'delayed',
      config: { after_event: 'custom', days: 1, unless_event: 'meeting_booked' },
    }) as { id: number }
    const journey = await runOp(db, 'owner', 'journey_upsert', {
      name: 'After a day', trigger_id: trigger.id, entry_mode: 'once',
    }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: journey.id,
      graph: { start: 'n', nodes: [{ id: 'n', kind: 'note' }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: journey.id, status: 'live' })
    await emitLeadEvent(db, { type: 'custom', company_id: co, source: 'test' })
    await scanDueTriggers(db, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))
    await runDueJourneys(db)
    const { rows } = await db.query<{ context: { cancel_on?: string[] } }>(
      'select context from lp.journey_runs where journey_id = $1',
      [journey.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].context.cancel_on).toEqual(['meeting_booked'])
  })
})
