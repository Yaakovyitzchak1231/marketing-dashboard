import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown, role: 'editor' as string | null, actor: 'owner' } }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => holder.role,
  currentActorId: async () => holder.actor,
  currentEmail: async () => null,
}))

import { PATCH } from '@/app/api/leads/bulk-edit/route'
import { bulkEditSentence, bulkUpdateCompanies, BULK_COMPANY_FIELDS, EDITOR_BULK_EDIT_CAP } from '@/lib/edit/bulk'
import { requestValueChange, isValueChangePayload } from '@/lib/edit/ask-change'
import { pendingApprovals } from '@/lib/ops/queries'
import { decideApproval } from '@/lib/ops/core'

const patch = (body: Record<string, unknown>, confirm = true) =>
  PATCH(new Request('http://x/api/leads/bulk-edit', { method: 'PATCH', body: JSON.stringify(confirm ? { ...body, confirm: true } : body) }))

describe('bulk edit (row 7)', () => {
  let db: TestDb
  let a: number, b: number, c: number
  beforeAll(async () => {
    db = await createTestDb()
    a = await addCompany(db, { name: 'Alpha Gems' })
    b = await addCompany(db, { name: 'Beta Gems' })
    c = await addCompany(db, { name: 'Gamma Gems' })
  })
  afterAll(async () => {
    await db.close()
  })

  it('offers the inline-edit company whitelist minus stage', () => {
    expect(BULK_COMPANY_FIELDS).toEqual(['website', 'phone', 'city', 'state'])
  })

  it('refuses viewers (403) and answers 503 with no database', async () => {
    holder.role = 'viewer'
    holder.db = db
    expect((await patch({ company_ids: [a], field: 'city', value: 'Baltimore' })).status).toBe(403)
    holder.role = 'editor'
    holder.db = null
    expect((await patch({ company_ids: [a], field: 'city', value: 'Baltimore' })).status).toBe(503)
  })

  it('validates the body and the field', async () => {
    holder.db = db
    holder.role = 'editor'
    expect((await patch({ company_ids: [], field: 'city', value: 'x' })).status).toBe(400)
    expect((await patch({ company_ids: [a], field: 'stage', value: 'ready' })).status).toBe(400)
    expect((await patch({ company_ids: [a], field: 'name', value: 'Same Name' })).status).toBe(400) // never bulk
    const unconfirmed = await patch({ company_ids: [a], field: 'city', value: 'Nowhere' }, false)
    expect(unconfirmed.status).toBe(400)
    expect((await unconfirmed.json()).error).toMatch(/Confirm/)
    const r = await db.query<{ city: string | null }>('select city from lp.companies where id = $1', [a])
    expect(r.rows[0].city).not.toBe('Nowhere')
  })

  it('updates each lead through the inline-edit path, one audit row each, and says it plainly', async () => {
    holder.db = db
    await db.query(`update lp.companies set city = 'Towson' where id = $1`, [c])
    const before = await db.query<{ n: number }>(`select count(*)::int as n from lp.status_history where field = 'city'`)
    // c is updated first so a second run proves "unchanged"
    const res = await patch({ company_ids: [a, b, c], field: 'city', value: 'Towson' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ field: 'city', updated: 2, unchanged: 1, failed: [] })
    expect(body.message).toBe('City: 2 updated, 1 unchanged.')
    const after = await db.query<{ n: number; who: string }>(
      `select count(*)::int as n, min(changed_by) as who from lp.status_history where field = 'city' and id > 0 and entity_type = 'company'`,
    )
    expect(after.rows[0].n - before.rows[0].n).toBe(2)
    expect(after.rows[0].who).toBe('owner')
  })

  it('caps editors at 500 leads; owners are not held to that cap', async () => {
    const many = Array.from({ length: EDITOR_BULK_EDIT_CAP + 1 }, (_, i) => i + 1)
    await expect(bulkUpdateCompanies(db, 'owner', { ids: many, field: 'city', value: 'x', isOwner: false })).rejects.toThrow(/at most 500/)
    holder.role = 'editor'
    expect((await patch({ company_ids: many, field: 'city', value: 'x' })).status).toBe(403)
  })

  it('reports per-lead failures without undoing the rest', async () => {
    const r = await bulkUpdateCompanies(db, 'owner', { ids: [a, 999999], field: 'state', value: 'MD', isOwner: true })
    expect(r.updated).toBe(1)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].id).toBe(999999)
    expect(bulkEditSentence(r)).toMatch(/^State: 1 updated, 0 unchanged, 1 failed: #999999 /)
  })
})

describe('ask to change an Instantly-backed number (row 7)', () => {
  let db: TestDb
  let co: number, camp: number, openedId = 0
  beforeAll(async () => {
    db = await createTestDb()
    await db.tx((q) => q.query(`insert into lp.actors (id, kind, display_name, harness, active, role) values ('editor1', 'human', 'Ed', 'dashboard', true, 'editor'), ('editor2', 'human', 'Edna', 'dashboard', true, 'editor') on conflict (id) do nothing`), 'owner')
    co = await addCompany(db, { name: 'Delta Jewelers' })
    camp = (await db.query<{ id: number }>(`insert into lp.campaigns (name, pool) values ('Spring', 'jeweler') returning id`)).rows[0].id
    for (const t of ['email_sent', 'email_sent', 'email_opened'])
      await db.query(`insert into lp.lead_events (type, company_id, campaign_id, source) values ($1, $2, $3, 'instantly_webhook')`, [t, co, camp])
  })
  afterAll(async () => {
    await db.close()
  })

  it('files a pending approval with the stored current value, the proposed value and the reason; the count is untouched', async () => {
    const { approval, payload } = await requestValueChange(db, 'editor1', { companyId: co, campaignId: camp, field: 'opens', proposed: '0', reason: 'Apple privacy pre-fetch, not a real open' })
    openedId = approval.id
    expect(approval.status).toBe('pending')
    expect(approval.action).toBe('other')
    expect(payload).toMatchObject({ field: 'opens', field_label: 'Opens', current: 1, proposed: 0, entity_id: co, campaign_id: camp })
    expect(approval.summary).toBe('Change Opens for Delta Jewelers in Spring from 1 to 0: Apple privacy pre-fetch, not a real open')
    const queued = await pendingApprovals(db)
    const row = queued.find((q) => q.id === approval.id)
    expect(row && isValueChangePayload(row.payload)).toBe(true)
    const n = await db.query<{ n: number }>(`select count(*)::int as n from lp.lead_events where type = 'email_opened' and company_id = $1`, [co])
    expect(n.rows[0].n).toBe(1)
  })

  it('ignores any browser-sent current value and refuses bad input', async () => {
    const r = await requestValueChange(db, 'owner', { companyId: co, campaignId: camp, field: 'steps', proposed: 3, reason: 'one bounced send missing' })
    expect(r.payload.current).toBe(2)
    await expect(requestValueChange(db, 'owner', { companyId: co, campaignId: camp, field: 'steps', proposed: 2, reason: 'x' })).rejects.toThrow(/already reads 2/)
    await expect(requestValueChange(db, 'owner', { companyId: co, campaignId: camp, field: 'clicks', proposed: 1, reason: 'x' })).rejects.toThrow(/field must be/)
    await expect(requestValueChange(db, 'owner', { companyId: co, campaignId: camp, field: 'opens', proposed: -1, reason: 'x' })).rejects.toThrow(/whole number/)
    await expect(requestValueChange(db, 'owner', { companyId: co, campaignId: camp, field: 'opens', proposed: '', reason: 'x' })).rejects.toThrow(/whole number/)
    await expect(requestValueChange(db, 'owner', { companyId: co, campaignId: camp, field: 'opens', proposed: 4, reason: '  ' })).rejects.toThrow(/why/)
  })

  it('allows only one pending request per lead + field, even when two race', async () => {
    await expect(requestValueChange(db, 'owner', { companyId: co, campaignId: camp, field: 'opens', proposed: 5, reason: 'again' })).rejects.toThrow(
      "There's already a pending request to change Opens for this lead in this campaign.",
    )
    const race = await Promise.allSettled([
      requestValueChange(db, 'owner', { companyId: co, campaignId: camp, field: 'replies', proposed: 1, reason: 'a' }),
      requestValueChange(db, 'owner', { companyId: co, campaignId: camp, field: 'replies', proposed: 2, reason: 'b' }),
    ])
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const n = await db.query<{ n: number }>(`select count(*)::int as n from lp.approvals where status = 'pending' and payload->>'field' = 'replies' and payload->>'entity_id' = $1`, [String(co)])
    expect(n.rows[0].n).toBe(1)
  })

  it('dedupes per lead + campaign + field: another campaign is allowed, the same one is 409', async () => {
    const camp2 = (await db.query<{ id: number }>(`insert into lp.campaigns (name, pool) values ('Autumn', 'jeweler') returning id`)).rows[0].id
    const other = await requestValueChange(db, 'owner', { companyId: co, campaignId: camp2, field: 'opens', proposed: 3, reason: 'other campaign' })
    expect(other.approval.status).toBe('pending')
    expect(other.payload.current).toBe(0)
    const dup = requestValueChange(db, 'owner', { companyId: co, campaignId: camp2, field: 'opens', proposed: 4, reason: 'again' })
    await expect(dup).rejects.toMatchObject({ status: 409 })
    await db.query(`update lp.approvals set status = 'rejected' where id = $1`, [other.approval.id])
  })

  it('only an owner can decide it; once decided, a new request may be filed', async () => {
    await expect(decideApproval(db, 'editor2', openedId, 'approved')).rejects.toThrow(/Only an owner/)
    const d = await decideApproval(db, 'owner', openedId, 'rejected', 'opens are real')
    expect(d.status).toBe('rejected')
    const again = await requestValueChange(db, 'owner', { companyId: co, campaignId: camp, field: 'opens', proposed: 2, reason: 'one missing' })
    expect(again.approval.status).toBe('pending')
  })
})
