import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { emitLeadEvent } from '@/lib/events/emit'
import { runOp } from '@/lib/ops/dispatch'
import { runDueJourneys } from '@/lib/journeys/runner'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

const INTERACTION = {
  start: 'check',
  nodes: [
    { id: 'check', kind: 'branch', paths: [
      { label: 'clicked', to: 'hot' },
      { label: 'opened', to: 'warm' },
      { label: 'no-open', to: 'cold' },
    ] },
    { id: 'hot', kind: 'note' },
    { id: 'warm', kind: 'note' },
    { id: 'cold', kind: 'note' },
  ],
}

describe('branch nodes (plan 3.5)', () => {
  let db: TestDb
  let co: number

  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Branch Co', domain: 'branch.example', city: 'Towson' })
  })
  afterAll(async () => db.close())

  async function enroll(name: string, graph: unknown, company = co) {
    const j = await runOp(db, 'owner', 'journey_upsert', { name }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: company }) as { results: { run_id: number }[] }
    return en.results[0].run_id
  }

  async function nodeOf(runId: number) {
    const { rows } = await db.query<{ node_id: string; status: string }>('select node_id, status from lp.journey_runs where id = $1', [runId])
    return rows[0]
  }

  it('takes clicked over opened, and no-open when neither happened', async () => {
    const quiet = await enroll('No open', INTERACTION)
    await runDueJourneys(db)
    expect(await nodeOf(quiet)).toMatchObject({ node_id: 'cold', status: 'done' })

    const opener = await addCompany(db, { name: 'Opener', domain: 'open.example', city: 'Towson' })
    const opened = await enroll('Opened', INTERACTION, opener)
    await emitLeadEvent(db, { type: 'email_opened', company_id: opener, source: 'test' })
    await runDueJourneys(db)
    expect(await nodeOf(opened)).toMatchObject({ node_id: 'warm', status: 'done' })

    const clicker = await addCompany(db, { name: 'Clicker', domain: 'click.example', city: 'Towson' })
    const clicked = await enroll('Clicked', INTERACTION, clicker)
    await emitLeadEvent(db, { type: 'email_opened', company_id: clicker, source: 'test' })
    await emitLeadEvent(db, { type: 'email_link_clicked', company_id: clicker, source: 'test' })
    await runDueJourneys(db)
    expect(await nodeOf(clicked)).toMatchObject({ node_id: 'hot', status: 'done' })
  })

  it('if/else takes yes when the event happened, else no', async () => {
    const graph = {
      start: 'gate',
      nodes: [
        { id: 'gate', kind: 'branch', config: { if: { event: 'reply_received' } }, paths: [
          { label: 'yes', to: 'thanks' },
          { label: 'no', to: 'nudge' },
        ] },
        { id: 'thanks', kind: 'note' },
        { id: 'nudge', kind: 'note' },
      ],
    }
    const no = await enroll('No reply', graph)
    await runDueJourneys(db)
    expect(await nodeOf(no)).toMatchObject({ node_id: 'nudge' })

    const who = await addCompany(db, { name: 'Replied', domain: 'replied.example', city: 'Towson' })
    const yes = await enroll('Replied', graph, who)
    await emitLeadEvent(db, { type: 'reply_received', company_id: who, source: 'test' })
    await runDueJourneys(db)
    expect(await nodeOf(yes)).toMatchObject({ node_id: 'thanks' })
  })
})
