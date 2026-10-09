import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
vi.mock('server-only', () => ({}))

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { InstantlyWriter } from '@/lib/instantly/writer'
import { NotHumanError, campaignSwitch, confirmAddLeads, buildAddPreview, savePreview } from '@/lib/instantly/add-leads'
import { decideInstantlyApproval, expireStaleInstantlyRequests, requestAddLeads, requestCampaignSwitch } from '@/lib/instantly/gate'
import { decideApproval } from '@/lib/ops/core'
import { routeToOp, runOp } from '@/lib/ops/dispatch'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'

const CID = '0199aa11-2222-7333-8444-555566667777'

type Call = { url: string; method: string; body: unknown }
function fakeFetch(responses: Response[]) {
  const calls: Call[] = []
  const f: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    const next = responses.shift()
    if (!next) throw new Error('unexpected call to Instantly')
    return next
  }
  return { f, calls }
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const writer = (f: typeof fetch) => new InstantlyWriter({ apiKey: 'test-key-123456', baseUrl: 'https://instantly.test/api/v2', fetchImpl: f, sleep: async () => undefined })
const neverCalled = () => writer(fakeFetch([]).f)

describe('approval gate before Instantly', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  const co: Record<string, number> = {}
  beforeAll(async () => {
    vi.stubEnv('INSTANTLY_API_KEY', '')
    vi.stubEnv('INSTANTLY_WRITE_API_KEY', '')
    db = await createTestDb()
    co.a = await addCompany(db, { name: 'Alpha Jewelers', domain: 'alpha.com' })
    await addContact(db, co.a, 'ann@alpha.com', 'valid')
    await db.query("update lp.contacts set first_name = 'Ann' where email = 'ann@alpha.com'")
    co.b = await addCompany(db, { name: 'Beta Gems', domain: 'beta.com' })
    await addContact(db, co.b, 'bo@beta.com', 'valid')
    co.c = await addCompany(db, { name: 'Gamma Gold', domain: 'gamma.com' })
    await addContact(db, co.c, 'cy@gamma.com', 'unverified')
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await db.close()
  })

  it('an agent request only queues: preview stored, approval pending, humans notified, logged with the agent as actor', async () => {
    const lookup = vi.fn(async () => [] as string[])
    const r = await requestAddLeads(db, 'tab', { campaign_id: CID, campaign_name: 'Seg 1', company_ids: [co.a, co.b, co.c], reason: 'Segment 1 batch' }, lookup)
    expect(r.executed).toBe(false)
    expect(r.action.status).toBe('awaiting_approval')
    expect(r.action.created_by).toBe('tab')
    expect(r.approval.status).toBe('pending')
    expect(r.approval.instantly_action_id).toBe(r.action.id)
    expect(r.preview.ready_count).toBe(2)
    expect(r.preview.excluded_count).toBe(1)
    expect(r.preview.excluded_by_reason).toEqual({ not_verified: 1 })
    expect(r.preview.sample?.map((s) => s.email).sort()).toEqual(['ann@alpha.com', 'bo@beta.com'])
    expect(r.preview.diff[0].to).toMatch(/^\+2/)
    expect(r.approval.summary).toMatch(/Add 2 leads to “Seg 1” in Instantly \(1 left out\)/)
    const ev = await db.query<{ actor: string; kind: string; summary: string }>("select actor, kind, summary from lp.events where kind = 'approval.requested' order by id desc limit 1")
    expect(ev.rows[0].actor).toBe('tab')
    expect(ev.rows[0].summary).toMatch(/nothing sent/)
    const n = await db.query<{ recipient: string }>("select recipient from lp.notifications where kind = 'approval' and created_by = 'tab'")
    expect(n.rows.map((x) => x.recipient)).toContain('owner')
    const touches = await db.query<{ n: number }>("select count(*)::int as n from lp.campaign_touches where event_type = 'added_to_campaign'")
    expect(touches.rows[0].n).toBe(0)
  })

  it('agents can name leads by email; unknown emails are said, and no leads at all is refused', async () => {
    const r = await requestAddLeads(db, 'hermes', { campaign_id: CID, emails: ['BO@beta.com', 'ghost@nowhere.com'], reason: 'x' }, null)
    expect(r.preview.ready_count).toBe(1)
    expect(r.preview.instantly_note).toMatch(/1 email\(s\) are not in the dashboard/)
    await expect(requestAddLeads(db, 'hermes', { campaign_id: CID, emails: ['ghost@nowhere.com'] }, null)).rejects.toThrow(/name the leads/)
    await expect(requestAddLeads(db, 'hermes', { campaign_id: '../leads', company_ids: [co.a] }, null)).rejects.toThrow(/campaign id/)
  })

  it('an agent can ask for the role-inbox batch; the batch rides the stored preview', async () => {
    const r = await requestAddLeads(db, 'hermes', { campaign_id: CID, company_ids: [co.a], batch: 'role-inbox', reason: 'role inboxes' }, null)
    expect(r.action.preview?.batch).toBe('role-inbox')
    await expect(requestAddLeads(db, 'hermes', { campaign_id: CID, company_ids: [co.a], batch: 'everyone', reason: 'x' }, null)).rejects.toThrow(/batch must be/)
  })

  it('only a human decides: an agent is refused, the generic approve path is refused, own requests are refused', async () => {
    const r = await requestAddLeads(db, 'tab', { campaign_id: CID, company_ids: [co.a], reason: 'x' }, null)
    await expect(decideInstantlyApproval(db, neverCalled(), 'hermes', r.approval.id, 'approved', { confirm: true })).rejects.toThrow(/only a signed-in human/)
    await expect(decideInstantlyApproval(db, neverCalled(), 'tab', r.approval.id, 'approved', { confirm: true })).rejects.toThrow(/only a signed-in human/)
    await expect(decideApproval(db, 'owner', r.approval.id, 'approved')).rejects.toThrow(/Instantly change/)
    const still = await db.query<{ status: string }>('select status from lp.approvals where id = $1', [r.approval.id])
    expect(still.rows[0].status).toBe('pending')
  })

  it('Approve without the confirm click, or with Instantly actions off, sends nothing and keeps it waiting', async () => {
    const r = await requestAddLeads(db, 'tab', { campaign_id: CID, company_ids: [co.b], reason: 'x' }, null)
    await expect(decideInstantlyApproval(db, neverCalled(), 'owner', r.approval.id, 'approved', { confirm: false })).rejects.toThrow(/not confirmed/)
    await expect(decideInstantlyApproval(db, null, 'owner', r.approval.id, 'approved', { confirm: true })).rejects.toThrow(/actions are off/)
    const a = await db.query<{ status: string }>('select status from lp.instantly_actions where id = $1', [r.action.id])
    expect(a.rows[0].status).toBe('awaiting_approval')
  })

  it('a confirmed Approve runs exactly the stored change once, as the human, and logs approver and requester', async () => {
    const fx = await addCompany(db, { name: 'Delta Diamonds' })
    await addContact(db, fx, 'dee@delta.com', 'valid')
    const fy = await addCompany(db, { name: 'Echo Estate' })
    const echo = await addContact(db, fy, 'ed@echo.com', 'valid')
    const r = await requestAddLeads(db, 'tab', { campaign_id: CID, campaign_name: 'Seg 2', company_ids: [fx, fy], reason: 'Seg 2' }, null)
    expect(r.preview.ready_count).toBe(2)
    // Echo is marked do-not-contact after the agent asked: it is dropped at approval time.
    await db.query('update lp.contacts set do_not_contact = true where id = $1', [echo])
    const { f, calls } = fakeFetch([json({ status: 'success', leads_uploaded: 1 })])
    const out = await decideInstantlyApproval(db, writer(f), 'owner', r.approval.id, 'approved', { confirm: true, note: 'go' })
    expect(out.ok).toBe(true)
    expect(out.executed).toBe(true)
    expect(out.message).toMatch(/1 dropped since the request/)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://instantly.test/api/v2/leads/add')
    expect((calls[0].body as { leads: { email: string }[] }).leads.map((l) => l.email)).toEqual(['dee@delta.com'])
    expect(out.action.status).toBe('done')
    expect(out.action.confirmed_by).toBe('owner')
    expect(out.approval.status).toBe('approved')
    expect(out.approval.decided_by).toBe('owner')
    const ev = await db.query<{ actor: string; kind: string; data: { requested_by?: string } | null }>(
      "select actor, kind, data from lp.events where kind in ('approval.approved', 'instantly.add_leads') order by id desc limit 2",
    )
    expect(ev.rows.map((e) => [e.kind, e.actor])).toEqual([['instantly.add_leads', 'owner'], ['approval.approved', 'owner']])
    expect(ev.rows[0].data?.requested_by).toBe('tab')
    // A second approve is refused and sends nothing.
    await expect(decideInstantlyApproval(db, neverCalled(), 'owner', r.approval.id, 'approved', { confirm: true })).rejects.toThrow(/already approved/)
  })

  it('Reject needs a reason, records it, sends nothing and tells the agent', async () => {
    const r = await requestCampaignSwitch(db, 'tab', { kind: 'pause', campaign_id: CID, campaign_name: 'Seg 1', reason: 'bounces high', current_status: 'active' })
    expect(r.preview.diff).toEqual([{ field: 'Campaign status', from: 'active', to: 'paused' }])
    await expect(decideInstantlyApproval(db, null, 'owner', r.approval.id, 'rejected', { note: '' })).rejects.toThrow(/say why/)
    const out = await decideInstantlyApproval(db, null, 'owner', r.approval.id, 'rejected', { note: 'bounces are from one inbox, not the list' })
    expect(out.executed).toBe(false)
    expect(out.action.status).toBe('rejected')
    expect(out.action.decision_note).toBe('bounces are from one inbox, not the list')
    expect(out.approval.status).toBe('rejected')
    const n = await db.query<{ summary: string }>("select summary from lp.notifications where recipient = 'tab' order by id desc limit 1")
    expect(n.rows[0].summary).toMatch(/Rejected: Pause “Seg 1”.*one inbox/)
    const ev = await db.query<{ actor: string; summary: string }>("select actor, summary from lp.events where kind = 'approval.rejected' order by id desc limit 1")
    expect(ev.rows[0]).toMatchObject({ actor: 'owner' })
    expect(ev.rows[0].summary).toMatch(/Why: bounces are from one inbox/)
  })

  it('an approved pause / resume calls the matching Instantly endpoint', async () => {
    const r = await requestCampaignSwitch(db, 'tab', { kind: 'resume', campaign_id: CID, campaign_name: 'Seg 1', reason: 'fixed' })
    const { f, calls } = fakeFetch([json({ id: CID, status: 1 })])
    const out = await decideInstantlyApproval(db, writer(f), 'owner', r.approval.id, 'approved', { confirm: true })
    expect(out.ok).toBe(true)
    expect(calls.map((c) => [c.method, c.url])).toEqual([['POST', `https://instantly.test/api/v2/campaigns/${CID}/activate`]])
    expect(out.action.status).toBe('done')
  })

  it('expired requests are cancelled and cannot be approved', async () => {
    const r = await requestCampaignSwitch(db, 'tab', { kind: 'pause', campaign_id: CID, reason: 'x' })
    await db.query("update lp.approvals set expires_at = now() - interval '1 minute' where id = $1", [r.approval.id])
    await expect(decideInstantlyApproval(db, neverCalled(), 'owner', r.approval.id, 'approved', { confirm: true })).rejects.toThrow(/expired/)
    const a = await db.query<{ status: string }>('select status from lp.instantly_actions where id = $1', [r.action.id])
    expect(a.rows[0].status).toBe('cancelled')
    const r2 = await requestCampaignSwitch(db, 'tab', { kind: 'pause', campaign_id: CID, reason: 'y' })
    await db.query("update lp.approvals set expires_at = now() - interval '1 minute' where id = $1", [r2.approval.id])
    expect(await expireStaleInstantlyRequests(db)).toBe(1)
  })
})

describe('default-deny: no agent path reaches Instantly', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  let company: number
  beforeAll(async () => {
    vi.stubEnv('INSTANTLY_API_KEY', '')
    db = await createTestDb()
    company = await addCompany(db, { name: 'Zeta' })
    await addContact(db, company, 'z@zeta.com', 'valid')
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await db.close()
  })
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('the database refuses a send whose confirmer is not a human', async () => {
    await expect(
      db.query(`insert into lp.instantly_actions (kind, campaign_id, status, created_by, confirmed_by) values ('pause', $1, 'sending', 'tab', 'tab')`, [CID]),
    ).rejects.toThrow(/Only a signed-in human/)
    const p = await buildAddPreview(db, { campaign_id: CID, company_ids: [company] }, null)
    const row = await savePreview(db, 'tab', p)
    await expect(db.query("update lp.instantly_actions set status = 'sending', confirmed_by = 'tab' where id = $1", [row.id])).rejects.toThrow(/Only a signed-in human/)
    await expect(db.query("update lp.instantly_actions set status = 'sending', confirmed_by = null where id = $1", [row.id])).rejects.toThrow(/Only a signed-in human/)
  })

  it('the send functions refuse an agent before any request', async () => {
    const p = await buildAddPreview(db, { campaign_id: CID, company_ids: [company] }, null)
    const row = await savePreview(db, 'owner', p)
    const { f, calls } = fakeFetch([])
    await expect(confirmAddLeads(db, writer(f), row.id, 'tab')).rejects.toBeInstanceOf(NotHumanError)
    await expect(campaignSwitch(db, writer(f), 'hermes', { kind: 'pause', campaign_id: CID })).rejects.toBeInstanceOf(NotHumanError)
    expect(calls).toHaveLength(0)
  })

  it('ops API: instantly_* ops only queue (reason required); a generic approval about Instantly is refused', async () => {
    await expect(runOp(db, 'tab', 'instantly_add_leads', { campaign_id: CID, company_ids: [company] })).rejects.toThrow(/reason is required/)
    const r = (await runOp(db, 'tab', 'instantly_add_leads', { campaign_id: CID, company_ids: [company], reason: 'test' })) as { executed: boolean; action: { id: number; status: string } }
    expect(r.executed).toBe(false)
    expect(r.action.status).toBe('awaiting_approval')
    const got = (await runOp(db, 'tab', 'get_instantly_action', { action_id: r.action.id })) as { status: string }
    expect(got.status).toBe('awaiting_approval')
    const pz = (await runOp(db, 'claude', 'instantly_pause_campaign', { campaign_id: CID, reason: 'too many bounces' })) as { approval: { status: string }; preview: { diff: { from: string }[] } }
    expect(pz.approval.status).toBe('pending')
    expect(pz.preview.diff[0].from).toBe('not read')
    await expect(runOp(db, 'tab', 'request_approval', { action: 'send', summary: 'Add 40 leads to the Instantly campaign' })).rejects.toThrow(/instantly_add_leads/)
    await expect(runOp(db, 'tab', 'request_approval', { action: 'other', summary: 'edit sequence', payload: { tool: 'INSTANTLY_UPDATE_CAMPAIGN' } })).rejects.toThrow(/not approved this way/)
    const ok = (await runOp(db, 'tab', 'request_approval', { action: 'spend', summary: 'Run 200 ZeroBounce checks', est_cost_usd: 2 })) as { status: string }
    expect(ok.status).toBe('pending')
  })

  it('REST aliases route to the gated ops', () => {
    expect(routeToOp('POST', ['instantly', 'add-leads'])).toEqual({ op: 'instantly_add_leads', args: {} })
    expect(routeToOp('POST', ['instantly', 'pause'])).toEqual({ op: 'instantly_pause_campaign', args: {} })
    expect(routeToOp('POST', ['instantly', 'resume'])).toEqual({ op: 'instantly_resume_campaign', args: {} })
    expect(routeToOp('GET', ['instantly', 'actions', '7'])).toEqual({ op: 'get_instantly_action', args: { action_id: 7 } })
  })

  it('only the human server actions and the gate can hold an Instantly writer', () => {
    const root = join(__dirname, '..')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        if (n === 'node_modules' || n.startsWith('.')) continue
        const p = join(dir, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx|mjs|js)$/.test(n)) files.push(p)
      }
    }
    for (const d of ['app', 'lib', 'engine', 'scripts', 'components']) walk(join(root, d))
    const holders = files
      .filter((p) => /writerFromEnv\(|new InstantlyWriter\(|\.addLeads\(|\.pause\(|\.resume\(/.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(root.length + 1))
      .sort()
    expect(holders).toEqual([
      'app/actions/instantly-approvals.ts',
      'app/actions/reports.ts',
      'lib/instantly/add-leads.ts',
      'lib/instantly/writer.ts',
    ])
  })
})
