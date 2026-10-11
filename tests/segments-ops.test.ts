import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('segment ops', () => {
  let db: TestDb
  let coA: number
  let coB: number

  beforeAll(async () => {
    db = await createTestDb()
    coA = await addCompany(db, { name: 'Alpha Jewelers', state: 'NY' })
    await addContact(db, coA, 'a@alpha.example', 'valid')
    coB = await addCompany(db, { name: 'Beta Jewelers', state: 'NJ' })
    await addContact(db, coB, 'b@beta.example', 'valid')
  })

  afterAll(async () => {
    await db.close()
  })

  it('segment_fields returns the registry', async () => {
    const fields = (await runOp(db, 'tab', 'segment_fields', {})) as { key: string }[]
    expect(fields.map((f) => f.key)).toContain('company.state')
    expect(fields.map((f) => f.key)).toContain('contact.verification_status')
  })

  it('create_segment validates the definition and writes an audit row', async () => {
    const def = { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'NY' }] }] }
    const seg = (await runOp(db, 'tab', 'create_segment', { name: 'NY leads', entity: 'company', definition: def })) as { id: number; name: string }
    expect(seg.name).toBe('NY leads')
    const { rows } = await db.query(`select * from lp.status_history where entity_type = 'segment' and entity_id = $1`, [seg.id])
    expect(rows.length).toBeGreaterThan(0)

    await expect(runOp(db, 'tab', 'create_segment', { name: 'bad', entity: 'company', definition: { entity: 'contact', include: [] } })).rejects.toThrow(OpsError)
    await expect(runOp(db, 'tab', 'create_segment', { name: 'bad2', entity: 'company', definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'nope', op: 'is', value: 1 }] }] } })).rejects.toThrow(OpsError)
  })

  it('segment_preview compiles an unsaved definition to counts + readback + sample', async () => {
    const result = (await runOp(db, 'tab', 'segment_preview', {
      entity: 'company',
      include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'in', value: ['NY', 'NJ'] }] }],
    })) as { counts: { companies: number; contacts: number; verified_sendable: number }; sample: unknown[]; readback: string }
    expect(result.counts.companies).toBe(2)
    expect(result.sample.length).toBe(2)
    expect(result.readback).toContain('State is NY or NJ')
  })

  it('update_segment changes the definition; entity cannot change', async () => {
    const seg = (await runOp(db, 'tab', 'create_segment', {
      name: 'Updatable',
      entity: 'company',
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'NY' }] }] },
    })) as { id: number }
    const updated = (await runOp(db, 'tab', 'update_segment', {
      id: seg.id,
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'NJ' }] }] },
    })) as { definition: { include: { conditions: { value: string }[] }[] } }
    expect(updated.definition.include[0].conditions[0].value).toBe('NJ')
    await expect(runOp(db, 'tab', 'update_segment', { id: seg.id, definition: { entity: 'contact', include: [] } })).rejects.toThrow(OpsError)
  })

  it('archive_segment is idempotent and get_segment 404s on unknown id', async () => {
    const seg = (await runOp(db, 'tab', 'create_segment', { name: 'ToArchive', entity: 'company', definition: { entity: 'company', include: [] } })) as { id: number }
    const archived = (await runOp(db, 'tab', 'archive_segment', { id: seg.id })) as { archived_at: string | null }
    expect(archived.archived_at).not.toBeNull()
    const archivedAgain = (await runOp(db, 'tab', 'archive_segment', { id: seg.id })) as { archived_at: string | null }
    expect(archivedAgain.archived_at).not.toBeNull()
    await expect(runOp(db, 'tab', 'get_segment', { id: 999999 })).rejects.toMatchObject({ status: 404 })
  })

  it('static segment: add/remove members emits segment_joined / segment_left lead events', async () => {
    const seg = (await runOp(db, 'tab', 'create_segment', {
      name: 'Trade show list',
      entity: 'company',
      kind: 'static',
      definition: { entity: 'company', include: [] },
    })) as { id: number }
    const added = (await runOp(db, 'tab', 'segment_add_members', { id: seg.id, company_ids: [coA, coB] })) as { added: number }
    expect(added.added).toBe(2)
    const members1 = (await runOp(db, 'tab', 'segment_members', { id: seg.id })) as { kind: string; members: { id: number }[] }
    expect(members1.kind).toBe('static')
    expect(members1.members.map((m) => m.id).sort()).toEqual([coA, coB].sort())
    const { rows: joinedEvents } = await db.query(`select * from lp.lead_events where type = 'segment_joined' and company_id = any($1::bigint[])`, [[coA, coB]])
    expect(joinedEvents.length).toBe(2)

    // Re-adding the same member is a no-op (on conflict do nothing), not a duplicate.
    const addedAgain = (await runOp(db, 'tab', 'segment_add_members', { id: seg.id, company_ids: [coA] })) as { added: number }
    expect(addedAgain.added).toBe(0)

    const removed = (await runOp(db, 'tab', 'segment_remove_members', { id: seg.id, company_ids: [coA] })) as { removed: number }
    expect(removed.removed).toBe(1)
    const members2 = (await runOp(db, 'tab', 'segment_members', { id: seg.id })) as { members: { id: number }[] }
    expect(members2.members.map((m) => m.id)).toEqual([coB])
    const { rows: leftEvents } = await db.query(`select * from lp.lead_events where type = 'segment_left' and company_id = $1`, [coA])
    expect(leftEvents.length).toBe(1)

    // A dynamic segment refuses hand-add/remove.
    const dyn = (await runOp(db, 'tab', 'create_segment', { name: 'Dynamic', entity: 'company', definition: { entity: 'company', include: [] } })) as { id: number }
    await expect(runOp(db, 'tab', 'segment_add_members', { id: dyn.id, company_ids: [coA] })).rejects.toThrow(OpsError)
  })

  it('segment_snapshot writes one row per live segment and is safe to re-run same-day', async () => {
    const before = (await runOp(db, 'tab', 'list_segments', {})) as { id: number }[]
    const first = (await runOp(db, 'tab', 'segment_snapshot', {})) as { segments: number; results: { segment_id: number; written: boolean }[] }
    expect(first.segments).toBe(before.length)
    expect(first.results.every((r) => r.written)).toBe(true)
    const second = (await runOp(db, 'tab', 'segment_snapshot', {})) as { results: { written: boolean }[] }
    expect(second.results.every((r) => !r.written)).toBe(true) // same-day re-run: no new rows
  })
})
