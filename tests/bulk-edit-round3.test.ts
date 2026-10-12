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
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { to })
  },
}))
vi.mock('@/lib/notify/kick', () => ({ kickDelivery: () => {} }))

import { bulkEditSentence, bulkUpdateCompanies } from '@/lib/edit/bulk'
import { requestValueChange } from '@/lib/edit/ask-change'
import { decideApprovalAction } from '@/app/actions/ops'

describe('bulk edit round 3 (row 7, Kilo review)', () => {
  let db: TestDb
  let live: number, gone: number, other: number
  beforeAll(async () => {
    db = await createTestDb()
    live = await addCompany(db, { name: 'Survivor Jewelers' })
    gone = await addCompany(db, { name: 'Merged Away Jewelers' })
    other = await addCompany(db, { name: 'Third Jewelers' })
    await db.query('update lp.companies set merged_into = $1 where id = $2', [live, gone])
  })
  afterAll(async () => {
    await db.close()
  })

  it('never edits a merged-away company: it fails by name and points at the survivor', async () => {
    const r = await bulkUpdateCompanies(db, 'owner', { ids: [gone, other], field: 'city', value: 'Annapolis', isOwner: true })
    expect(r.updated).toBe(1)
    expect(r.failed).toEqual([{ id: gone, error: `This lead was merged into #${live}; edit that one instead.` }])
    const row = await db.query<{ city: string | null }>('select city from lp.companies where id = $1', [gone])
    expect(row.rows[0].city).not.toBe('Annapolis')
  })

  it('an unexpected error keeps what saved, names the failure, and stops', async () => {
    let calls = 0
    const flaky = new Proxy(db, {
      get(t, k, recv) {
        if (k === 'tx') {
          return (...args: unknown[]) => {
            calls++
            if (calls === 2) throw new Error('connection reset')
            return (t.tx as (...a: unknown[]) => unknown).apply(t, args)
          }
        }
        const v = Reflect.get(t, k, recv)
        return typeof v === 'function' ? v.bind(t) : v
      },
    }) as TestDb
    const a = await addCompany(db, { name: 'One' })
    const b = await addCompany(db, { name: 'Two' })
    const c = await addCompany(db, { name: 'Three' })
    const r = await bulkUpdateCompanies(flaky, 'owner', { ids: [a, b, c], field: 'state', value: 'VA', isOwner: true })
    expect(r.updated).toBe(1)
    expect(r.failed).toEqual([{ id: b, error: 'Could not save (server error).' }])
    expect(r.skipped).toBe(1)
    expect(bulkEditSentence(r)).toMatch(/1 not tried \(stopped after a server error\)\.$/)
  })
})

describe('deciding an approval from Activity (row 7, Kilo review)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    await db.tx((q) => q.query(`insert into lp.actors (id, kind, display_name, harness, active, role) values ('editor1', 'human', 'Ed', 'dashboard', true, 'editor') on conflict (id) do nothing`), 'owner')
    holder.db = db
  })
  afterAll(async () => {
    await db.close()
  })

  it('a refusal comes back as a note on Activity, not the error page', async () => {
    const co = await addCompany(db, { name: 'Echo Jewelers' })
    const camp = (await db.query<{ id: number }>(`insert into lp.campaigns (name, pool) values ('Winter', 'jeweler') returning id`)).rows[0].id
    await db.query(`insert into lp.lead_events (type, company_id, campaign_id, source) values ('email_opened', $1, $2, 'instantly_webhook')`, [co, camp])
    const { approval } = await requestValueChange(db, 'owner', { companyId: co, campaignId: camp, field: 'opens', proposed: 0, reason: 'bot open' })
    holder.role = 'editor'
    holder.actor = 'editor1'
    const fd = new FormData()
    fd.set('approval_id', String(approval.id))
    fd.set('decision', 'approved')
    const err = (await decideApprovalAction(fd).catch((e) => e)) as { to?: string }
    expect(err.to).toBe(`/activity?tone=bad&note=${encodeURIComponent('Only an owner can decide a request to change an Instantly number.')}`)
    const still = await db.query<{ status: string }>('select status from lp.approvals where id = $1', [approval.id])
    expect(still.rows[0].status).toBe('pending')
  })
})
