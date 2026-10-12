import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The shared box is slow; PGlite boots a full Postgres per test.
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 })
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { ActionError, getAction, listActions } from '@/lib/actions/registry'
import { listStepLog, runAction } from '@/lib/actions/execute'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

const ACTOR = 'owner'

async function makeCampaign(db: TestDb): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `insert into lp.campaigns (name, pool) values ('Action lib test', 'jeweler') returning id`,
    [],
  )
  return rows[0].id
}

describe('action library registry', () => {
  it('lists the built-in actions with discoverable args', () => {
    const keys = listActions().map((a) => a.key).sort()
    expect(keys).toEqual(['lead.update', 'suppression.add', 'tag.add', 'tag.remove', 'task.create'])
    for (const a of listActions()) {
      expect(a.label.length).toBeGreaterThan(0)
      expect(a.description.length).toBeGreaterThan(0)
      expect(a.args).toMatch(/^\{.*\}$/)
    }
  })
  it('rejects unknown actions with the known list', () => {
    expect(() => getAction('nope')).toThrow(ActionError)
    expect(() => getAction('nope')).toThrow(/Known:/)
  })
})

describe('runAction + step log (db)', () => {
  let db: TestDb
  let campaignId: number
  let companyId: number

  beforeEach(async () => {
    db = await createTestDb()
    campaignId = await makeCampaign(db)
    companyId = await addCompany(db, { name: 'Action Co' })
  })
  afterEach(async () => {
    await db.close()
  })

  const ctx = () => ({ campaign_id: campaignId, step_key: 'n1', company_id: companyId })

  it('task.create creates a task and logs ok', async () => {
    const r = await runAction(db, ACTOR, 'task.create', { title: 'Call them', company_id: companyId }, ctx())
    expect(r.status).toBe('ok')
    expect(r.log_id).toBeGreaterThan(0)
    const tasks = await db.query<{ title: string }>(`select title from lp.tasks where company_id = $1`, [companyId])
    expect(tasks.rows.map((t) => t.title)).toContain('Call them')
    const log = await listStepLog(db, { campaign_id: campaignId })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ action: 'task.create', status: 'ok', step_key: 'n1', actor: ACTOR })
  })

  it('lead.update changes the field and logs ok', async () => {
    const r = await runAction(db, ACTOR, 'lead.update', { type: 'company', id: companyId, field: 'city', value: 'Baltimore' }, ctx())
    expect(r.status).toBe('ok')
    const c = await db.query<{ city: string }>(`select city from lp.companies where id = $1`, [companyId])
    expect(c.rows[0].city).toBe('Baltimore')
    expect((await listStepLog(db, { action: 'lead.update' }))[0].status).toBe('ok')
  })

  it('tag.add and tag.remove round-trip and log', async () => {
    await runAction(db, ACTOR, 'tag.add', { company_id: companyId, tag: 'vip' }, ctx())
    let c = await db.query<{ tags: string[] }>(`select tags from lp.companies where id = $1`, [companyId])
    expect(c.rows[0].tags).toContain('vip')
    await runAction(db, ACTOR, 'tag.remove', { company_id: companyId, tag: 'vip' }, ctx())
    c = await db.query<{ tags: string[] }>(`select tags from lp.companies where id = $1`, [companyId])
    expect(c.rows[0].tags).not.toContain('vip')
    expect(await listStepLog(db, { company_id: companyId })).toHaveLength(2)
  })

  it('suppression.add suppresses and logs', async () => {
    const r = await runAction(
      db, ACTOR, 'suppression.add', { email: 'spam@example.com', reason: 'bounced' }, ctx(),
    )
    expect(r.status).toBe('ok')
    const s = await db.query(`select email_norm from lp.suppressions where email_norm = 'spam@example.com'`)
    expect(s.rows.length).toBe(1)
  })

  it('unknown action throws before writing any log row', async () => {
    await expect(runAction(db, ACTOR, 'nope', {}, ctx())).rejects.toThrow(ActionError)
    expect(await listStepLog(db, { campaign_id: campaignId })).toHaveLength(0)
  })

  it('a failed action still leaves a failed log row with the error', async () => {
    await expect(
      runAction(db, ACTOR, 'tag.add', { company_id: 999999, tag: 'x' }, ctx()),
    ).rejects.toThrow()
    const log = await listStepLog(db, { campaign_id: campaignId })
    expect(log).toHaveLength(1)
    expect(log[0].status).toBe('failed')
    expect(log[0].error).toMatch(/No company 999999/)
  })

  it('listStepLog filters by action and lead', async () => {
    await runAction(db, ACTOR, 'tag.add', { company_id: companyId, tag: 'a' }, ctx())
    await runAction(db, ACTOR, 'task.create', { title: 't', company_id: companyId }, ctx())
    expect(await listStepLog(db, { action: 'tag.add' })).toHaveLength(1)
    expect(await listStepLog(db, { company_id: companyId, limit: 1 })).toHaveLength(1)
    expect(await listStepLog(db, { company_id: 123456 })).toHaveLength(0)
  })
})
