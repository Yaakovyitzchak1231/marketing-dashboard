import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))

import { InstantlyWriter, InstantlyWriteError, allowedWrite, actionsEnabled, writerFromEnv } from '@/lib/instantly/writer'
import { buildAddPreview, campaignSwitch, confirmAddLeads, getAction, savePreview } from '@/lib/instantly/add-leads'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact, addTouch } from './helpers/lead-fixtures'

const CID = '0199aa11-2222-7333-8444-555566667777'

type Call = { url: string; method: string; body: unknown; auth: string | null }
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = []
  const f: typeof fetch = async (input, init) => {
    const h = new Headers(init?.headers)
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, auth: h.get('authorization') })
    const next = responses.shift()
    if (!next) throw new Error('unexpected call')
    if (next instanceof Error) throw next
    return next
  }
  return { f, calls }
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers })
const writer = (f: typeof fetch) => new InstantlyWriter({ apiKey: 'test-key-123456', baseUrl: 'https://instantly.test/api/v2', fetchImpl: f, sleep: async () => undefined })

describe('Instantly writer: only three allowed changes', () => {
  it('allows pause, activate and leads/add, nothing else', () => {
    expect(allowedWrite(`/campaigns/${CID}/pause`)).toBe(true)
    expect(allowedWrite(`/campaigns/${CID}/activate`)).toBe(true)
    expect(allowedWrite('/leads/add')).toBe(true)
    expect(allowedWrite(`/campaigns/${CID}`)).toBe(false)
    expect(allowedWrite('/leads')).toBe(false)
    expect(allowedWrite('/emails/reply')).toBe(false)
    expect(allowedWrite(`/campaigns/${CID}/delete`)).toBe(false)
  })

  it('pause and resume hit the v2 endpoints with POST and the key in a header', async () => {
    const { f, calls } = fakeFetch([json({ id: CID, status: 2 }), json({ id: CID, status: 1 })])
    await writer(f).pause(CID)
    await writer(f).resume(CID)
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', `https://instantly.test/api/v2/campaigns/${CID}/pause`],
      ['POST', `https://instantly.test/api/v2/campaigns/${CID}/activate`],
    ])
    expect(calls[0].auth).toBe('Bearer test-key-123456')
    expect(calls[0].url).not.toContain('test-key')
  })

  it('adds leads with skip_if_in_workspace on and never verifies on import (no paid step)', async () => {
    const { f, calls } = fakeFetch([json({ status: 'success', leads_uploaded: 1 })])
    await writer(f).addLeads(CID, [{ email: 'a@b.com', first_name: 'Al' }])
    expect(calls[0].body).toEqual({ campaign_id: CID, leads: [{ email: 'a@b.com', first_name: 'Al' }], skip_if_in_workspace: true, verify_leads_on_import: false })
  })

  it('refuses a bad id and an oversized batch before any request', async () => {
    const { f, calls } = fakeFetch([])
    await expect(writer(f).pause('../leads')).rejects.toThrow(/not an Instantly campaign id/)
    await expect(writer(f).addLeads(CID, [])).rejects.toThrow(/No leads/)
    await expect(writer(f).addLeads(CID, Array.from({ length: 1001 }, (_, i) => ({ email: `${i}@x.com` })))).rejects.toThrow(/1000/)
    expect(calls).toHaveLength(0)
  })

  it('403 says which scope; 5xx and network errors are "outcome unknown" and never retried', async () => {
    const a = fakeFetch([json({ message: 'Forbidden' }, 403)])
    await expect(writer(a.f).pause(CID)).rejects.toThrow(/campaigns:update/)
    const b = fakeFetch([json({}, 502)])
    const e = await writer(b.f).addLeads(CID, [{ email: 'a@b.com' }]).catch((x) => x)
    expect(e).toBeInstanceOf(InstantlyWriteError)
    expect((e as InstantlyWriteError).unknownOutcome).toBe(true)
    expect(b.calls).toHaveLength(1)
    const c = fakeFetch([new Error('ECONNRESET')])
    const e2 = await writer(c.f).pause(CID).catch((x) => x)
    expect((e2 as InstantlyWriteError).unknownOutcome).toBe(true)
  })

  it('retries a 429 (nothing happened) and then succeeds', async () => {
    const { f, calls } = fakeFetch([json({}, 429, { 'retry-after': '1' }), json({ status: 1 })])
    await writer(f).resume(CID)
    expect(calls).toHaveLength(2)
  })

  it('scrubs the key from error messages', async () => {
    const { f } = fakeFetch([json({ message: 'bad key test-key-123456' }, 400)])
    const e = await writer(f).pause(CID).catch((x) => x)
    expect(String(e.message)).not.toContain('test-key-123456')
  })

  it('is off without a key or with INSTANTLY_ACTIONS=off', () => {
    expect(actionsEnabled({})).toBe(false)
    expect(actionsEnabled({ INSTANTLY_API_KEY: 'k' })).toBe(true)
    expect(actionsEnabled({ INSTANTLY_API_KEY: 'k', INSTANTLY_ACTIONS: 'off' })).toBe(false)
    expect(writerFromEnv({ INSTANTLY_API_KEY: 'k', INSTANTLY_ACTIONS: 'off' })).toBeNull()
    expect(writerFromEnv({ INSTANTLY_WRITE_API_KEY: 'w' })).toBeInstanceOf(InstantlyWriter)
  })
})

describe('Add selected to an Instantly campaign', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  const co: Record<string, number> = {}
  beforeAll(async () => {
    db = await createTestDb()
    co.ready = await addCompany(db, { name: 'Ready Gems', domain: 'ready.com' })
    await addContact(db, co.ready, 'info@ready.com', 'valid', { role: true })
    await addContact(db, co.ready, 'sam@ready.com', 'valid')
    await db.query("update lp.contacts set first_name = 'Sam', personalization = 'Saw your bridal line' where email = 'sam@ready.com'")
    co.unverified = await addCompany(db, { name: 'Unverified' })
    await addContact(db, co.unverified, 'u@unv.com', 'unverified')
    co.invalid = await addCompany(db, { name: 'Invalid' })
    await addContact(db, co.invalid, 'bad@inv.com', 'invalid')
    co.dnc = await addCompany(db, { name: 'DNC' })
    const d = await addContact(db, co.dnc, 'n@dnc.com', 'valid')
    await db.query('update lp.contacts set do_not_contact = true where id = $1', [d])
    co.inInstantly = await addCompany(db, { name: 'Already There' })
    await addContact(db, co.inInstantly, 'there@x.com', 'valid')
    co.touched = await addCompany(db, { name: 'Touched' })
    const t = await addContact(db, co.touched, 't@touched.com', 'valid')
    await db.query("update lp.campaign_touches set campaign_id = 'old'")
    await addTouch(db, { companyId: co.touched, contactId: t, campaign: 'Old', event: 'email_sent', at: '2026-10-01T00:00:00Z' })
    await db.query("update lp.campaign_touches set campaign_id = 'old'")
    co.noEmail = await addCompany(db, { name: 'No email' })
    co.ready2 = await addCompany(db, { name: 'Ready Two' })
    await addContact(db, co.ready2, 'owner@two.com', 'valid')
  })
  afterAll(async () => {
    await db.close()
  })

  it('previews: only verified, not-in-Instantly, never-contacted leads are ready; the rest say why', async () => {
    const lookup = vi.fn(async (emails: string[]) => emails.filter((e) => e === 'there@x.com'))
    const p = await buildAddPreview(db, { campaign_id: CID, campaign_name: 'Seg 1', company_ids: Object.values(co) }, lookup)
    expect(lookup).toHaveBeenCalledOnce()
    expect(p.ready.map((l) => l.email).sort()).toEqual(['owner@two.com', 'sam@ready.com']) // the named address beats info@
    const why = Object.fromEntries(p.excluded.map((l) => [l.company, l.excluded]))
    expect(why).toEqual({
      Unverified: 'not_verified',
      Invalid: 'invalid',
      DNC: 'do_not_contact',
      'Already There': 'in_instantly',
      Touched: 'already_in_campaign',
    })
    expect(p.instantlyChecked).toBe(true)
  })

  it('a failed duplicate lookup is said, not hidden', async () => {
    const p = await buildAddPreview(db, { campaign_id: CID, company_ids: [co.ready] }, async () => {
      throw new Error('rate limited')
    })
    expect(p.instantlyChecked).toBe(false)
    expect(p.instantlyNote).toMatch(/rate limited/)
    expect(p.ready).toHaveLength(1)
  })

  it('confirm sends the stored list once, records touches and status; a second confirm sends nothing', async () => {
    const p = await buildAddPreview(db, { campaign_id: CID, campaign_name: 'Seg 1', company_ids: [co.ready, co.ready2] }, async () => [])
    const row = await savePreview(db, 'owner', p)
    expect(row.status).toBe('preview')
    const { f, calls } = fakeFetch([json({ status: 'success', total_sent: 2, leads_uploaded: 2 })])
    const out = await confirmAddLeads(db, writer(f), row.id, 'owner')
    expect(out.action.status).toBe('done')
    expect(out.message).toMatch(/added 2/)
    expect(calls).toHaveLength(1)
    const sent = (calls[0].body as { leads: { email: string; personalization?: string; company_name?: string }[] }).leads
    expect(sent.find((l) => l.email === 'sam@ready.com')).toMatchObject({ personalization: 'Saw your bridal line', company_name: 'Ready Gems', first_name: 'Sam' })

    const again = await confirmAddLeads(db, writer(fakeFetch([]).f), row.id, 'owner')
    expect(again.sent).toBe(false)
    expect(again.message).toMatch(/Already done/)

    const { rows: touches } = await db.query<{ email: string; event_type: string; campaign_id: string }>(
      "select email, event_type, campaign_id from lp.campaign_touches where event_type = 'added_to_campaign' order by email",
    )
    expect(touches).toEqual([
      { email: 'owner@two.com', event_type: 'added_to_campaign', campaign_id: CID },
      { email: 'sam@ready.com', event_type: 'added_to_campaign', campaign_id: CID },
    ])
    const { rows: st } = await db.query<{ status: string }>("select status from lp.contacts where email = 'sam@ready.com'")
    expect(st[0].status).toBe('in-Instantly')
    const { rows: stage } = await db.query<{ stage: string }>('select stage from lp.companies where id = $1', [co.ready])
    expect(stage[0].stage).toBe('in_campaign')
    const { rows: ev } = await db.query<{ summary: string }>("select summary from lp.events where kind = 'instantly.add_leads'")
    expect(ev[0].summary).toMatch(/Added leads to "Seg 1": 2 sent, Instantly took 2/)
  })

  it('a refused send changes nothing in our records', async () => {
    const c = await addCompany(db, { name: 'Fresh' })
    await addContact(db, c, 'fresh@f.com', 'valid')
    const p = await buildAddPreview(db, { campaign_id: CID, company_ids: [c] }, async () => [])
    const row = await savePreview(db, 'owner', p)
    const out = await confirmAddLeads(db, writer(fakeFetch([json({ message: 'nope' }, 403)]).f), row.id, 'owner')
    expect(out.action.status).toBe('failed')
    expect(out.message).toMatch(/leads:create/)
    const { rows } = await db.query<{ status: string }>("select status from lp.contacts where email = 'fresh@f.com'")
    expect(rows[0].status).toBe('new')
    expect((await getAction(db, row.id))?.error).toMatch(/leads:create/)
  })

  it('pause / resume are recorded with the outcome', async () => {
    const ok = await campaignSwitch(db, writer(fakeFetch([json({ status: 2 })]).f), 'owner', { kind: 'pause', campaign_id: CID, campaign_name: 'Seg 1' })
    expect(ok.ok).toBe(true)
    expect(ok.action.status).toBe('done')
    const bad = await campaignSwitch(db, writer(fakeFetch([json({}, 500)]).f), 'owner', { kind: 'resume', campaign_id: CID, campaign_name: 'Seg 1' })
    expect(bad.ok).toBe(false)
    expect(bad.action.status).toBe('unknown')
    const { rows } = await db.query<{ kind: string; summary: string }>("select kind, summary from lp.events where kind like 'instantly.%' and kind not like '%add%' order by id")
    expect(rows.map((r) => r.kind)).toEqual(['instantly.pause', 'instantly.resume_failed'])
    expect(rows[0].summary).toBe('Paused "Seg 1" in Instantly')
  })
})
