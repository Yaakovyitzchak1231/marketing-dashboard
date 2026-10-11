import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { updateEntity, updateEntityFields, RegistryError } from '@/lib/edit/update'
import { entityHistory, recentChanges } from '@/lib/edit/history'
import { EDIT_OPS } from '@/lib/edit/ops'
import { fieldDef } from '@/lib/edit/registry'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function addCampaign(db: TestDb, name: string, pool = 'jeweler'): Promise<number> {
  const { rows } = await db.query<{ id: number }>(`insert into lp.campaigns (name, pool) values ($1, $2) returning id`, [name, pool])
  return rows[0].id
}
async function addCampaignLead(db: TestDb, campaignId: number, companyId: number): Promise<void> {
  await db.query(`insert into lp.campaign_leads (campaign_id, company_id) values ($1, $2)`, [campaignId, companyId])
}
async function addTask(db: TestDb, title: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>(`insert into lp.tasks (kind, title) values ('manual', $1) returning id`, [title])
  return rows[0].id
}
async function historyRows(db: TestDb, type: string, id: number) {
  const { rows } = await db.query<{ field: string; old_value: string | null; new_value: string | null; changed_by: string; via: string | null; note: string | null }>(
    `select field, old_value, new_value, changed_by, via, note from lp.status_history where entity_type = $1 and entity_id = $2 order by id`,
    [type, id],
  )
  return rows
}

describe('lib/edit/registry — the universal inline-edit whitelist', () => {
  let db: TestDb
  let gem: number
  beforeAll(async () => {
    db = await createTestDb()
    gem = await addCompany(db, { name: 'Gem Co', state: 'MD', city: 'Baltimore', domain: 'gemco.com' })
  })
  afterAll(async () => db.close())

  it('rejects an unknown entity type', async () => {
    expect(() => fieldDef('widget', 'name')).toThrow(RegistryError)
    await expect(updateEntity(db, 'owner', { type: 'widget', id: 1, field: 'name', value: 'x' })).rejects.toThrow(/not an editable entity type/)
  })

  it('rejects an unknown field on a known entity', async () => {
    expect(() => fieldDef('company', 'bogus_field')).toThrow(RegistryError)
    await expect(updateEntity(db, 'owner', { type: 'company', id: gem, field: 'bogus_field', value: 'x' })).rejects.toThrow(/can.t be edited/)
  })

  it('rejects an unknown field on contact and campaign too', async () => {
    await expect(updateEntity(db, 'owner', { type: 'contact', id: 1, field: 'ssn', value: 'x' })).rejects.toThrow(RegistryError)
    await expect(updateEntity(db, 'owner', { type: 'campaign', id: 1, field: 'secret', value: 'x' })).rejects.toThrow(RegistryError)
  })
})

describe('lib/edit/update — updateEntity (company, delegates to editCompany)', () => {
  let db: TestDb
  let gem: number
  beforeAll(async () => {
    db = await createTestDb()
    gem = await addCompany(db, { name: 'Gem Co', state: 'MD', city: 'Baltimore', domain: 'gemco.com' })
  })
  afterAll(async () => db.close())

  it('writes only a changed field and logs exactly one history row with actor + via', async () => {
    const r = await updateEntity(db, 'owner', { type: 'company', id: gem, field: 'city', value: 'Towson', via: 'ui' })
    expect(r).toMatchObject({ changed: true, field: 'city', from: 'Baltimore', to: 'Towson' })
    const rows = (await historyRows(db, 'company', gem)).filter((x) => x.field === 'city')
    expect(rows).toEqual([{ field: 'city', old_value: 'Baltimore', new_value: 'Towson', changed_by: 'owner', via: 'ui', note: null }])
  })

  it('no-ops when the value is unchanged: no row written, changed:false', async () => {
    const before = (await historyRows(db, 'company', gem)).length
    const r = await updateEntity(db, 'owner', { type: 'company', id: gem, field: 'city', value: 'Towson' })
    expect(r.changed).toBe(false)
    expect(await historyRows(db, 'company', gem)).toHaveLength(before)
  })

  it('an agent (via ops_api) is recorded as that agent', async () => {
    await db.query(`insert into lp.actors (id, kind, display_name) values ('hermes', 'agent', 'Hermes') on conflict do nothing`)
    const r = await updateEntity(db, 'hermes', { type: 'company', id: gem, field: 'state', value: 'VA', via: 'ops_api' })
    expect(r.changed).toBe(true)
    const rows = await historyRows(db, 'company', gem)
    const row = rows.find((x) => x.field === 'state')
    expect(row).toMatchObject({ changed_by: 'hermes', via: 'ops_api' })
  })
})

describe('lib/edit/update — company.stage does not double-log (DB trigger owns it)', () => {
  let db: TestDb
  let gem: number
  beforeAll(async () => {
    db = await createTestDb()
    gem = await addCompany(db, { name: 'Gem Co', state: 'MD', city: 'Baltimore', domain: 'gemco.com', stage: 'new' })
  })
  afterAll(async () => db.close())

  it('writes the stage column; the trigger (not update.ts) writes the one history row', async () => {
    const beforeRows = await historyRows(db, 'company', gem) // the insert trigger already logged stage: null -> new
    const r = await updateEntity(db, 'owner', { type: 'company', id: gem, field: 'stage', value: 'ready' })
    expect(r).toMatchObject({ changed: true, field: 'stage', from: 'new', to: 'ready' })
    const after = await historyRows(db, 'company', gem)
    expect(after.length).toBe(beforeRows.length + 1) // exactly one new row, not two
    const stageRows = after.filter((x) => x.field === 'stage')
    expect(stageRows.at(-1)).toMatchObject({ old_value: 'new', new_value: 'ready', changed_by: 'owner' })
  })
})

describe('lib/edit/update — contact (delegates to editContact; status trigger-owned)', () => {
  let db: TestDb
  let gem: number
  let contactId: number
  beforeAll(async () => {
    db = await createTestDb()
    gem = await addCompany(db, { name: 'Gem Co', state: 'MD', city: 'Baltimore', domain: 'gemco.com' })
    contactId = await addContact(db, gem, 'ruth@gemco.com', 'unverified')
  })
  afterAll(async () => db.close())

  it('edits a plain contact field and logs one history row', async () => {
    const r = await updateEntity(db, 'owner', { type: 'contact', id: contactId, field: 'title', value: 'Owner' })
    expect(r).toMatchObject({ changed: true, field: 'title', to: 'Owner' })
    const rows = (await historyRows(db, 'contact', contactId)).filter((x) => x.field === 'title')
    expect(rows).toEqual([{ field: 'title', old_value: null, new_value: 'Owner', changed_by: 'owner', via: 'ops_api', note: null }])
  })

  it('status is editable but the trigger writes its history row, not update.ts (no double-log)', async () => {
    const before = await historyRows(db, 'contact', contactId)
    const r = await updateEntity(db, 'owner', { type: 'contact', id: contactId, field: 'status', value: 'needs-check' })
    expect(r.changed).toBe(true)
    const after = await historyRows(db, 'contact', contactId)
    expect(after.length).toBe(before.length + 1)
    expect(after.at(-1)).toMatchObject({ field: 'status', old_value: 'new', new_value: 'needs-check' })
  })

  it('rejects a bad status value', async () => {
    await expect(updateEntity(db, 'owner', { type: 'contact', id: contactId, field: 'status', value: 'bogus-status' })).rejects.toThrow(RegistryError)
  })
})

describe('lib/edit/update — campaign (direct writer)', () => {
  let db: TestDb
  let campaignId: number
  beforeAll(async () => {
    db = await createTestDb()
    campaignId = await addCampaign(db, 'Spring push')
  })
  afterAll(async () => db.close())

  it('updates name and logs history', async () => {
    const r = await updateEntity(db, 'owner', { type: 'campaign', id: campaignId, field: 'name', value: 'Spring Push 2026' })
    expect(r).toMatchObject({ changed: true, from: 'Spring push', to: 'Spring Push 2026' })
    expect(await historyRows(db, 'campaign', campaignId)).toEqual([
      { field: 'name', old_value: 'Spring push', new_value: 'Spring Push 2026', changed_by: 'owner', via: 'ops_api', note: null },
    ])
  })

  it('pool is any slug now: a syntactically valid but unknown pool is refused by the FK, not a fixed list', async () => {
    await expect(updateEntity(db, 'owner', { type: 'campaign', id: campaignId, field: 'pool', value: 'not_a_real_pool' })).rejects.toThrow(/Unknown pool/)
  })

  it('a pool that exists in lp.pools (seeded) is accepted', async () => {
    const r = await updateEntity(db, 'owner', { type: 'campaign', id: campaignId, field: 'pool', value: 'ai_agency' })
    expect(r.changed).toBe(true)
  })

  it('updateEntityFields changes several fields in one call, one history row each', async () => {
    const results = await updateEntityFields(db, 'owner', { type: 'campaign', id: campaignId, fields: { goal: 'Book 10 demos', notes: 'Q2 push' } })
    expect(results.map((r) => r.field).sort()).toEqual(['goal', 'notes'])
    const rows = await historyRows(db, 'campaign', campaignId)
    expect(rows.filter((r) => r.field === 'goal')).toHaveLength(1)
    expect(rows.filter((r) => r.field === 'notes')).toHaveLength(1)
  })
})

describe('lib/edit/update — campaign_lead (composite id, per-campaign note context)', () => {
  let db: TestDb
  let campaignId: number
  let companyId: number
  beforeAll(async () => {
    db = await createTestDb()
    companyId = await addCompany(db, { name: 'Gem Co', domain: 'gemco.com' })
    campaignId = await addCampaign(db, 'Spring push')
    await addCampaignLead(db, campaignId, companyId)
  })
  afterAll(async () => db.close())

  it('accepts "<campaign_id>:<company_id>" as the id and writes note', async () => {
    const r = await updateEntity(db, 'owner', { type: 'campaign_lead', id: `${campaignId}:${companyId}`, field: 'note', value: 'Follow up Monday' })
    expect(r).toMatchObject({ changed: true, field: 'note', to: 'Follow up Monday' })
    const { rows } = await db.query<{ note: string }>('select note from lp.campaign_leads where campaign_id = $1 and company_id = $2', [campaignId, companyId])
    expect(rows[0].note).toBe('Follow up Monday')
  })

  it('rejects a malformed id', async () => {
    await expect(updateEntity(db, 'owner', { type: 'campaign_lead', id: 'nope', field: 'note', value: 'x' })).rejects.toThrow(RegistryError)
  })

  it('history for this campaign_lead is scoped to this campaign (note carries campaign context)', async () => {
    const rows = await entityHistory(db, 'campaign_lead', `${campaignId}:${companyId}`)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].note).toContain(`campaign ${campaignId}`)
  })
})

describe('lib/edit/update — task (direct writer, status whitelist matches update_task)', () => {
  let db: TestDb
  let taskId: number
  beforeAll(async () => {
    db = await createTestDb()
    taskId = await addTask(db, 'Research Gem Co')
  })
  afterAll(async () => db.close())

  it('updates title and priority, one history row each', async () => {
    await updateEntity(db, 'owner', { type: 'task', id: taskId, field: 'title', value: 'Research Gem Co ASAP' })
    const r = await updateEntity(db, 'owner', { type: 'task', id: taskId, field: 'priority', value: 5 })
    expect(r).toMatchObject({ changed: true, field: 'priority', to: '5' })
    const rows = await historyRows(db, 'task', taskId)
    expect(rows.map((x) => x.field).sort()).toEqual(['priority', 'title'])
  })

  it('rejects a status outside the known set', async () => {
    await expect(updateEntity(db, 'owner', { type: 'task', id: taskId, field: 'status', value: 'exploded' })).rejects.toThrow(RegistryError)
  })
})

describe('lib/edit/history — entityHistory and recentChanges', () => {
  let db: TestDb
  let a: number
  let b: number
  beforeAll(async () => {
    db = await createTestDb()
    a = await addCompany(db, { name: 'A Co', domain: 'a.com' })
    b = await addCompany(db, { name: 'B Co', domain: 'b.com' })
    await updateEntity(db, 'owner', { type: 'company', id: a, field: 'city', value: 'Baltimore' })
    await updateEntity(db, 'owner', { type: 'company', id: a, field: 'city', value: 'Towson' })
    await updateEntity(db, 'owner', { type: 'company', id: b, field: 'city', value: 'Reston' })
  })
  afterAll(async () => db.close())

  it('entityHistory returns one entity\'s rows newest first', async () => {
    const rows = await entityHistory(db, 'company', a)
    expect(rows.filter((r) => r.field === 'city').map((r) => r.new_value)).toEqual(['Towson', 'Baltimore'])
    expect(rows.every((r) => r.changed_by_name)).toBe(true)
  })

  it('recentChanges spans every entity, newest first, and can be narrowed', async () => {
    const rows = await recentChanges(db, { type: 'company', limit: 10 })
    expect(rows[0].new_value).toBe('Reston')
    const mine = await recentChanges(db, { actor: 'owner' })
    expect(mine.every((r) => r.changed_by === 'owner')).toBe(true)
  })
})

describe('lib/edit/ops — EDIT_OPS (the ops-API surface agents call)', () => {
  let db: TestDb
  let gem: number
  beforeAll(async () => {
    db = await createTestDb()
    gem = await addCompany(db, { name: 'Gem Co', domain: 'gemco.com', state: 'MD' })
  })
  afterAll(async () => db.close())

  it('update_entity dispatched as an agent records that agent as changed_by', async () => {
    await db.query(`insert into lp.actors (id, kind, display_name) values ('hermes', 'agent', 'Hermes') on conflict do nothing`)
    const r = (await EDIT_OPS.update_entity.run(db, 'hermes', { type: 'company', id: gem, field: 'state', value: 'VA' })) as { changed: boolean }
    expect(r.changed).toBe(true)
    const rows = await historyRows(db, 'company', gem)
    expect(rows.at(-1)).toMatchObject({ changed_by: 'hermes', via: 'ops_api' })
  })

  it('update_entity_fields requires an object of fields', async () => {
    await expect(EDIT_OPS.update_entity_fields.run(db, 'owner', { type: 'company', id: gem, fields: 'not-an-object' })).rejects.toThrow()
  })

  it('entity_history and recent_changes ops read back what update_entity wrote', async () => {
    const hist = (await EDIT_OPS.entity_history.run(db, 'owner', { type: 'company', id: gem, limit: 5 })) as unknown[]
    expect(hist.length).toBeGreaterThan(0)
    const recent = (await EDIT_OPS.recent_changes.run(db, 'owner', { type: 'company', limit: 5 })) as unknown[]
    expect(recent.length).toBeGreaterThan(0)
  })
})
