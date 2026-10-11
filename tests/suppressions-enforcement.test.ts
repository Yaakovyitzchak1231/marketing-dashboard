import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))

import { InstantlyWriter } from '@/lib/instantly/writer'
import { buildAddPreview, confirmAddLeads, savePreview, suppressionBreakdown } from '@/lib/instantly/add-leads'
import { requestAddLeads, decideInstantlyApproval } from '@/lib/instantly/gate'
import { addSuppression, liftSuppression } from '@/lib/suppressions/store'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'

const CID = '0199bb22-3333-7444-8555-666677778888'

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; body: unknown }[] = []
  const f: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
    const next = responses.shift()
    if (!next) throw new Error('unexpected call')
    if (next instanceof Error) throw next
    return next
  }
  return { f, calls }
}
const writer = (f: typeof fetch) => new InstantlyWriter({ apiKey: 'test-key-123456', baseUrl: 'https://instantly.test/api/v2', fetchImpl: f, sleep: async () => undefined })

describe('suppressionBreakdown', () => {
  it('reads as "N word, N word"', () => {
    expect(suppressionBreakdown(['unsubscribed', 'unsubscribed', 'competitor'])).toBe('2 unsubscribed, 1 competitor')
    expect(suppressionBreakdown([])).toBe('')
  })
})

describe('item 1.8 enforcement: suppressed leads never reach Instantly', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  const co: Record<string, number> = {}
  beforeAll(async () => {
    db = await createTestDb()
    co.clean = await addCompany(db, { name: 'Clean Co' })
    await addContact(db, co.clean, 'clean@clean.com', 'valid')
    co.unsub = await addCompany(db, { name: 'Unsub Co' })
    await addContact(db, co.unsub, 'gone@unsub.com', 'valid')
    co.competitor = await addCompany(db, { name: 'Riverside (competitor domain)' })
    await addContact(db, co.competitor, 'sales@rivalbrand.com', 'valid')
    await addSuppression(db, 'owner', { email: 'gone@unsub.com', reason: 'unsubscribed' })
    await addSuppression(db, 'owner', { domain: 'rivalbrand.com', reason: 'competitor' })
  })
  afterAll(async () => db.close())

  it('BEFORE the approval request: buildAddPreview excludes suppressed leads and reports why, without hiding them', async () => {
    const p = await buildAddPreview(db, { campaign_id: CID, campaign_name: 'Test', company_ids: [co.clean, co.unsub, co.competitor] }, async () => [])
    expect(p.ready.map((l) => l.email)).toEqual(['clean@clean.com'])
    const suppressed = p.excluded.filter((l) => l.excluded === 'suppressed')
    expect(suppressed.map((l) => l.email).sort()).toEqual(['gone@unsub.com', 'sales@rivalbrand.com'])
    expect(suppressed.find((l) => l.email === 'gone@unsub.com')?.suppression_reason).toBe('unsubscribed')
    expect(suppressed.find((l) => l.email === 'sales@rivalbrand.com')?.suppression_reason).toBe('competitor')
    expect(p.suppressedCount).toBe(2)
    expect(p.suppressedSummary).toMatch(/1 unsubscribed/)
    expect(p.suppressedSummary).toMatch(/1 competitor/)
  })

  it('an agent request (lib/instantly/gate.ts) reports the suppression breakdown in the human-readable summary', async () => {
    const out = await requestAddLeads(
      db,
      'tab',
      { campaign_id: CID, campaign_name: 'Test', company_ids: [co.clean, co.unsub, co.competitor], reason: 'weekly push' },
      async () => [],
    )
    expect(out.approval.summary).toMatch(/1 unsubscribed/)
    expect(out.approval.summary).toMatch(/1 competitor/)
    expect(out.preview.excluded_by_reason?.suppressed).toBe(2)
  })

  it('RIGHT BEFORE THE ACTUAL SEND: a lead suppressed AFTER the preview (but before confirm) is still dropped and never sent to Instantly', async () => {
    const freshCo = await addCompany(db, { name: 'Fresh At Preview Time' })
    await addContact(db, freshCo, 'fresh@notsuppressedyet.com', 'valid')
    const p = await buildAddPreview(db, { campaign_id: CID, campaign_name: 'Test', company_ids: [freshCo] }, async () => [])
    expect(p.ready.map((l) => l.email)).toEqual(['fresh@notsuppressedyet.com'])
    const row = await savePreview(db, 'owner', p)

    // State changes between approval and send: someone unsubscribes right now.
    await addSuppression(db, 'owner', { email: 'fresh@notsuppressedyet.com', reason: 'unsubscribed' })

    const { f, calls } = fakeFetch([]) // the writer must NEVER be called for this lead
    const out = await confirmAddLeads(db, writer(f), row.id, 'owner')
    expect(calls).toHaveLength(0)
    expect(out.sent).toBe(false)
    expect(out.message).toMatch(/Nothing was ready/)
    expect(out.action.error).toMatch(/nothing to send/)
  })

  it('an agent-approved request also rechecks suppression right before the send (the approve -> confirm path)', async () => {
    const freshCo = await addCompany(db, { name: 'Fresh Approved' })
    await addContact(db, freshCo, 'fresh2@approve-path.com', 'valid')
    const req = await requestAddLeads(db, 'tab', { campaign_id: CID, campaign_name: 'Test', company_ids: [freshCo], reason: 'test' }, async () => [])
    expect(req.preview.ready_count).toBe(1)

    await addSuppression(db, 'owner', { email: 'fresh2@approve-path.com', reason: 'do_not_contact' })

    const { f, calls } = fakeFetch([])
    const decided = await decideInstantlyApproval(db, writer(f), 'owner', req.approval.id, 'approved', { confirm: true })
    expect(calls).toHaveLength(0) // never reached Instantly
    expect(decided.executed).toBe(false)
    expect(decided.ok).toBe(false)
  })

  it('a lifted suppression lets the lead through again', async () => {
    const c = await addCompany(db, { name: 'Lifted Co' })
    await addContact(db, c, 'liftme@lifted.com', 'valid')
    const s = await addSuppression(db, 'owner', { email: 'liftme@lifted.com', reason: 'manual' })
    const before = await buildAddPreview(db, { campaign_id: CID, company_ids: [c] }, async () => [])
    expect(before.ready).toHaveLength(0)
    await liftSuppression(db, 'owner', { id: s.id })
    const after = await buildAddPreview(db, { campaign_id: CID, company_ids: [c] }, async () => [])
    expect(after.ready.map((l) => l.email)).toEqual(['liftme@lifted.com'])
  })

  it('a per-campaign (not global) suppression excludes only from that campaign, on the push path', async () => {
    const { rows: camps } = await db.query<{ id: number }>(
      `insert into lp.campaigns (name, pool, status, instantly_campaign_id, created_by, updated_by) values ('Linked', 'jeweler', 'draft', $1, 'owner', 'owner') returning id`,
      [CID.toLowerCase()],
    )
    const linkedCampaignId = Number(camps[0].id)
    const c = await addCompany(db, { name: 'Campaign Scoped' })
    await addContact(db, c, 'scoped@campaignonly.com', 'valid')
    await addSuppression(db, 'owner', { email: 'scoped@campaignonly.com', reason: 'do_not_contact', campaign_id: linkedCampaignId })
    // CID is linked to linkedCampaignId, so the per-campaign suppression applies here:
    const linked = await buildAddPreview(db, { campaign_id: CID, company_ids: [c] }, async () => [])
    expect(linked.ready).toHaveLength(0)
    // A different Instantly campaign id (no dashboard link) only sees GLOBAL suppressions:
    const unlinked = await buildAddPreview(db, { campaign_id: '0199cc33-4444-7555-8666-777788889999', company_ids: [c] }, async () => [])
    expect(unlinked.ready.map((l) => l.email)).toEqual(['scoped@campaignonly.com'])
  })
})
