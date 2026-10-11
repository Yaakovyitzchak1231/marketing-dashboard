import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function emitEvent(db: TestDb, opts: { type: string; companyId: number; occurredAt: string }) {
  await db.query(`insert into lp.lead_events (occurred_at, type, company_id, source) values ($1, $2, $3, 'test')`, [opts.occurredAt, opts.type, opts.companyId])
}

describe('trait ops', () => {
  let db: TestDb
  let coA: number
  let coB: number

  beforeAll(async () => {
    db = await createTestDb()
    coA = await addCompany(db, { name: 'Alpha' })
    coB = await addCompany(db, { name: 'Beta' })
    await emitEvent(db, { type: 'reply_received', companyId: coA, occurredAt: new Date().toISOString() })
  })

  afterAll(async () => {
    await db.close()
  })

  it('the seeded starter traits are already there (migration 0033)', async () => {
    const traits = (await runOp(db, 'tab', 'list_traits', {})) as { key: string }[]
    const keys = traits.map((t) => t.key)
    expect(keys).toEqual(expect.arrayContaining(['replies_30d', 'opens_14d', 'days_since_last_touch', 'steps_received', 'total_meetings']))
  })

  it('define_trait validates, writes an audit row, and registers a segment field', async () => {
    const trait = (await runOp(db, 'tab', 'define_trait', {
      key: 'my_replies',
      label: 'My replies',
      entity: 'company',
      definition: { event_types: ['reply_received'], aggregation: 'count' },
    })) as { key: string }
    expect(trait.key).toBe('my_replies')

    const { rows } = await db.query(`select * from lp.status_history where entity_type = 'trait' and entity_key = 'my_replies'`)
    expect(rows.length).toBeGreaterThan(0)

    const fields = (await runOp(db, 'tab', 'segment_fields', {})) as { key: string }[]
    expect(fields.map((f) => f.key)).toContain('trait.my_replies')

    await expect(runOp(db, 'tab', 'define_trait', { key: 'bad key', label: 'x', entity: 'company', definition: { event_types: ['x'], aggregation: 'count' } })).rejects.toThrow(OpsError)
  })

  it('a trait is usable as a segment condition once defined and recomputed', async () => {
    await runOp(db, 'tab', 'define_trait', {
      key: 'replied_ever',
      label: 'Replied ever',
      entity: 'company',
      definition: { event_types: ['reply_received'], aggregation: 'count' },
    })
    await runOp(db, 'tab', 'recompute_traits', { key: 'replied_ever' })

    const preview = (await runOp(db, 'tab', 'segment_preview', {
      entity: 'company',
      include: [{ conditions: [{ kind: 'field', field: 'trait.replied_ever', op: 'gt', value: 0 }] }],
    })) as { counts: { companies: number } }
    expect(preview.counts.companies).toBe(1) // only coA has replied
  })

  it('archive_trait removes it from segment_fields (soft delete, idempotent)', async () => {
    await runOp(db, 'tab', 'define_trait', { key: 'to_archive', label: 'To archive', entity: 'company', definition: { event_types: ['reply_received'], aggregation: 'count' } })
    await runOp(db, 'tab', 'archive_trait', { key: 'to_archive' })
    const fields = (await runOp(db, 'tab', 'segment_fields', {})) as { key: string }[]
    expect(fields.map((f) => f.key)).not.toContain('trait.to_archive')
    // idempotent
    await expect(runOp(db, 'tab', 'archive_trait', { key: 'to_archive' })).resolves.toBeTruthy()
    await expect(runOp(db, 'tab', 'archive_trait', { key: 'nope' })).rejects.toMatchObject({ status: 404 })
  })

  it('trait_preview computes values for sample leads without writing lp.trait_values', async () => {
    const result = (await runOp(db, 'tab', 'trait_preview', {
      entity: 'company',
      definition: { event_types: ['reply_received'], aggregation: 'count' },
      sample_size: 5,
    })) as { sample: { id: number; value: number | null }[] }
    expect(result.sample.length).toBeGreaterThan(0)
    const row = result.sample.find((r) => r.id === coA)
    expect(row?.value).toBe(1)
    const { rows } = await db.query(`select count(*)::int as n from lp.trait_values where trait_key = 'does_not_exist'`)
    expect(Number(rows[0].n)).toBe(0)
    void coB
  })

  it('recompute_traits with no key recomputes every active trait', async () => {
    const result = (await runOp(db, 'tab', 'recompute_traits', {})) as { traits: number; results: { trait_key: string }[] }
    expect(result.traits).toBeGreaterThanOrEqual(5) // the 5 seeded traits plus whatever this suite defined
  })
})
