import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact, addTouch } from './helpers/lead-fixtures'
import { parseLeadQuery, leadsHref, NONE } from '@/lib/leads/filters'
import { listLeads, kanbanLeads, campaignGroups, regionGroups, setStage, leadFacets, buildLeadWhere, Params } from '@/lib/leads/queries'
import { getLeadDetail } from '@/lib/leads/detail'
import { comment } from '@/lib/ops/core'
import { loadReplyDesk, groupReplies } from '@/lib/leads/replies'
import { loadOverview } from '@/lib/leads/overview'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('lead queries (real Postgres via PGlite)', () => {
  let db: TestDb
  const ids: Record<string, number> = {}
  const contacts: Record<string, number> = {}

  beforeAll(async () => {
    db = await createTestDb()
    ids.gem = await addCompany(db, { name: 'Gem Co', state: 'MD', city: 'Baltimore', domain: 'gemco.com', owner_name: 'Ruth Gold' })
    ids.ring = await addCompany(db, { name: 'Ring Bros', state: 'md', city: 'Towson', stage: 'ready', research_status: 'researched' })
    ids.bright = await addCompany(db, { name: 'Bright 100% Diamonds', state: 'NY', city: 'Albany', stage: 'in_campaign', research_status: 'failed' })
    ids.agency = await addCompany(db, { name: 'Flow Agents', state: 'CA', segment: 'ai_agency', stage: 'replied', research_status: 'researched' })
    ids.nostate = await addCompany(db, { name: 'Mystery Jewels', state: null, research_status: 'skipped' })
    for (let i = 0; i < 57; i++) await addCompany(db, { name: `Filler ${String(i).padStart(2, '0')}`, state: 'PA', research_status: 'researched' })

    contacts.gemOwner = await addContact(db, ids.gem, 'ruth@gemco.com', 'unverified')
    contacts.gemInfo = await addContact(db, ids.gem, 'info@gemco.com', 'valid', { role: true })
    contacts.ring = await addContact(db, ids.ring, 'sales@ringbros.com', 'valid')
    contacts.bright = await addContact(db, ids.bright, 'owner@bright.com', 'catch_all', { status: 'in-Instantly' })
    contacts.agency = await addContact(db, ids.agency, 'hi@flowagents.ai', 'valid', { status: 'replied' })

    await addTouch(db, { companyId: ids.bright, contactId: contacts.bright, email: 'owner@bright.com', campaign: 'Jewelers Q4', event: 'email_sent', at: '2026-10-01T10:00:00Z' })
    await addTouch(db, { contactId: contacts.agency, email: 'hi@flowagents.ai', campaign: 'Agencies A', event: 'email_sent', at: '2026-10-01T10:00:00Z' })
    await addTouch(db, {
      contactId: contacts.agency, email: 'hi@flowagents.ai', campaign: 'Agencies A', event: 'reply_received', at: '2026-10-02T10:00:00Z',
      payload: { reply_subject: 'Re: quick q', reply_text_snippet: 'Sure, tell me more', unibox_url: 'https://app.instantly.ai/unibox/x', lead_email: 'hi@flowagents.ai' },
    })
    await addTouch(db, { email: 'gone@nowhere.com', campaign: 'Jewelers Q4', event: 'email_bounced', at: '2026-10-03T10:00:00Z', payload: { unibox_url: 'javascript:alert(1)' } })
    await addTouch(db, { email: 'later@x.com', event: 'reply_received', at: '2026-10-03T10:00:00Z' })
    await addTouch(db, { email: 'later@x.com', event: 'email_sent', at: '2026-10-04T10:00:00Z' })
    await addTouch(db, { email: 'hot@x.com', event: 'reply_received', at: '2026-10-03T09:00:00Z', payload: { reply_text_snippet: 'Yes please' } })
    await addTouch(db, { email: 'hot@x.com', event: 'lead_interested', at: '2026-10-03T11:00:00Z' })
    await addTouch(db, { email: 'ooo@x.com', event: 'auto_reply_received', at: '2026-10-03T11:00:00Z' })
    await addTouch(db, { email: 'bye@x.com', event: 'lead_unsubscribed', at: '2026-10-03T12:00:00Z' })
    await addTouch(db, { email: 'meh@x.com', event: 'lead_not_interested', at: '2026-10-03T12:00:00Z' })
    await addTouch(db, { email: 'open@x.com', event: 'email_opened', at: '2026-10-03T12:00:00Z' })
  }, 30_000)
  afterAll(async () => {
    await db.close()
  })

  const q = (s: string) => parseLeadQuery(Object.fromEntries(new URLSearchParams(s)))

  it('paginates 50 per page with an honest total', async () => {
    const p1 = await listLeads(db, q(''))
    expect(p1.total).toBe(62)
    expect(p1.rows).toHaveLength(50)
    expect(p1.pages).toBe(2)
    const p2 = await listLeads(db, q('page=2'))
    expect(p2.rows).toHaveLength(12)
    const p9 = await listLeads(db, q('page=9'))
    expect(p9.page).toBe(2) // clamped, never an empty page past the end
  })

  it('sorts on whitelisted columns only', async () => {
    const byName = await listLeads(db, q('sort=name'))
    expect(byName.rows[0].name).toBe('Bright 100% Diamonds')
    const desc = await listLeads(db, q('sort=name&dir=desc'))
    expect(desc.rows[0].name).toBe('Ring Bros')
    const bogus = parseLeadQuery({ sort: 'name; drop table lp.companies' })
    expect(bogus.sort).toBe('updated')
  })

  it('filters: search across name/domain/email/city, with LIKE wildcards escaped', async () => {
    expect((await listLeads(db, q('q=ruth@'))).rows.map((r) => r.name)).toEqual(['Gem Co'])
    expect((await listLeads(db, q('q=gemco.com'))).total).toBe(1)
    expect((await listLeads(db, q('q=towson'))).rows[0].name).toBe('Ring Bros')
    expect((await listLeads(db, q('q=100%25'))).rows.map((r) => r.name)).toEqual(['Bright 100% Diamonds'])
    expect((await listLeads(db, q('q=%25'))).rows.map((r) => r.name)).toEqual(['Bright 100% Diamonds'])
  })

  it('filters: state (case-insensitive and "none"), stage, segment, verification, has-email, owner-known', async () => {
    expect((await listLeads(db, q('state=md'))).total).toBe(2)
    expect((await listLeads(db, q(`state=${NONE}`))).rows.map((r) => r.name)).toEqual(['Mystery Jewels'])
    expect((await listLeads(db, q('stage=ready'))).rows.map((r) => r.name)).toEqual(['Ring Bros'])
    expect((await listLeads(db, q('segment=ai_agency'))).rows.map((r) => r.name)).toEqual(['Flow Agents'])
    expect((await listLeads(db, q('verification=catch_all'))).rows.map((r) => r.name)).toEqual(['Bright 100% Diamonds'])
    expect((await listLeads(db, q('email=yes'))).total).toBe(4)
    expect((await listLeads(db, q('email=no'))).total).toBe(58)
    expect((await listLeads(db, q('owner=yes'))).rows.map((r) => r.name)).toEqual(['Gem Co'])
    expect((await listLeads(db, q('state=MD&stage=ready&email=yes'))).total).toBe(1)
  })

  it('filters by Find-leads job through lp.sources (kind engine, source_ref find_leads:<task id>)', async () => {
    await db.query(`insert into lp.sources (company_id, kind, source_ref) values ($1, 'engine', 'find_leads:77')`, [ids.ring])
    expect((await listLeads(db, q('job=77'))).rows.map((r) => r.name)).toEqual(['Ring Bros'])
    expect((await listLeads(db, q('job=78'))).total).toBe(0)
    expect(parseLeadQuery({ job: '1 or 1=1' }).filters.job).toBeUndefined()
  })

  it('keeps all user input out of the SQL text', () => {
    const p = new Params()
    const sql = buildLeadWhere({ q: "x' or 1=1 --", state: 'MD', campaign: "Q4'; drop" }, 'table', p)
    expect(sql).not.toContain("1=1")
    expect(sql).not.toContain('drop')
    expect(p.values).toContain('%x\' or 1=1 --%')
  })

  it('picks a primary email (valid, non-role first) and lists unverified contact ids', async () => {
    const gem = (await listLeads(db, q('q=gem co'))).rows[0]
    expect(gem.primary_email).toBe('info@gemco.com') // the only valid one
    expect(gem.contact_count).toBe(2)
    expect(gem.unverified_ids).toEqual([contacts.gemOwner])
  })

  it('views: needs-research and needs-verification', async () => {
    const research = await listLeads(db, q('view=research'))
    expect(research.rows.map((r) => r.name).sort()).toEqual(['Bright 100% Diamonds', 'Gem Co'])
    const verify = await listLeads(db, q('view=verify'))
    expect(verify.rows.map((r) => r.name)).toEqual(['Gem Co'])
  })

  it('kanban: one column per stage with counts and cards', async () => {
    const cols = await kanbanLeads(db, {})
    expect(cols.map((c) => c.stage)).toContain('do_not_contact')
    expect(cols.find((c) => c.stage === 'new')?.count).toBe(59)
    expect(cols.find((c) => c.stage === 'new')?.cards).toHaveLength(25)
    expect(cols.find((c) => c.stage === 'ready')?.cards.map((c) => c.name)).toEqual(['Ring Bros'])
    const capped = await kanbanLeads(db, {}, 10)
    const fresh = capped.find((c) => c.stage === 'new')!
    expect(fresh.cards).toHaveLength(10)
    expect(fresh.count).toBe(59)
    expect(capped.reduce((s, c) => s + c.count, 0)).toBe(62)
  })

  it('by campaign: groups by latest named campaign (company or contact touches), "no campaign" last', async () => {
    const groups = await campaignGroups(db, {})
    const keys = groups.map((g) => g.key)
    expect(keys[keys.length - 1]).toBeNull()
    expect(groups.find((g) => g.key === 'Jewelers Q4')?.total).toBe(1)
    expect(groups.find((g) => g.key === 'Agencies A')?.sample.map((s) => s.name)).toEqual(['Flow Agents'])
    expect(groups.find((g) => g.key === null)?.total).toBe(60)
    expect((await listLeads(db, q('campaign=Agencies%20A'))).rows.map((r) => r.name)).toEqual(['Flow Agents'])
    expect((await listLeads(db, q(`campaign=${NONE}`))).total).toBe(60)
  })

  it('by state: counts by stage per state, uppercase-normalized', async () => {
    const groups = await regionGroups(db, {})
    const md = groups.find((g) => g.key === 'MD')!
    expect(md.total).toBe(2)
    expect(md.byStage).toEqual({ new: 1, ready: 1 })
    expect(md.unverified).toBe(1)
    expect(groups.find((g) => g.key === 'PA')?.total).toBe(57)
    expect(groups[groups.length - 1].key).toBeNull()
  })

  it('set stage: changes only what differs, writes history as the actor, logs one event', async () => {
    const r = await setStage(db, [ids.gem, ids.ring, 999999], 'ready', 'owner')
    expect(r).toEqual({ updated: 1, unchanged: 1, missing: 1 })
    const h = await db.query<{ old_value: string; new_value: string; changed_by: string }>(
      `select old_value, new_value, changed_by from lp.status_history where entity_type = 'company' and entity_id = $1 order by id desc limit 1`,
      [ids.gem],
    )
    expect(h.rows[0]).toEqual({ old_value: 'new', new_value: 'ready', changed_by: 'owner' })
    const ev = await db.query<{ summary: string; actor: string }>(`select summary, actor from lp.events where kind = 'lead.stage_set' order by id desc limit 1`)
    expect(ev.rows[0]).toEqual({ summary: 'Yaakov moved Gem Co to Ready', actor: 'owner' })
    const none = await setStage(db, [ids.gem], 'ready', 'owner')
    expect(none.updated).toBe(0)
    await setStage(db, [ids.gem], 'new', 'owner')
  })

  it('comments on a lead go through the ops layer: @mentions notify each mentioned agent', async () => {
    const c = await comment(db, 'owner', { company_id: ids.gem, body: '@tab research the owner. @hermes fyi. @nobody' })
    expect(c.mentions.sort()).toEqual(['hermes', 'tab'])
    const n = await db.query<{ recipient: string }>(`select recipient from lp.notifications where comment_id = $1 order by recipient`, [c.id])
    expect(n.rows.map((r) => r.recipient)).toEqual(['hermes', 'tab'])
  })

  it('lead detail: contacts, touches via contacts, history, comments', async () => {
    const d = (await getLeadDetail(db, ids.agency))!
    expect(d.company.name).toBe('Flow Agents')
    expect(d.contacts.map((c) => c.email)).toEqual(['hi@flowagents.ai'])
    expect(d.touches.map((t) => t.event_type)).toEqual(['reply_received', 'email_sent'])
    const g = (await getLeadDetail(db, ids.gem))!
    expect(g.comments).toHaveLength(1)
    expect(g.history.some((h) => h.field === 'stage' && h.new_value === 'ready' && h.changed_by_name === 'Yaakov')).toBe(true)
    expect(await getLeadDetail(db, 424242)).toBeNull()
  })

  it('reply desk: one row per lead, bucketed by newest desk event; only https unibox links', async () => {
    const items = await loadReplyDesk(db)
    const by = Object.fromEntries(items.map((i) => [i.email, i]))
    expect(by['hi@flowagents.ai'].bucket).toBe('needs_reply')
    expect(by['hi@flowagents.ai'].company_name).toBe('Flow Agents')
    expect(by['hi@flowagents.ai'].snippet).toBe('Sure, tell me more')
    expect(by['later@x.com'].bucket).toBe('answered')
    expect(by['hot@x.com'].bucket).toBe('interested')
    expect(by['hot@x.com'].snippet).toBe('Yes please')
    expect(by['ooo@x.com'].bucket).toBe('auto')
    expect(by['bye@x.com'].bucket).toBe('unsubscribed')
    expect(by['meh@x.com'].bucket).toBe('not_now')
    expect(by['gone@nowhere.com'].bucket).toBe('bounced')
    expect(by['gone@nowhere.com'].unibox_url).toBeNull()
    expect(by['open@x.com']).toBeUndefined()
    expect(groupReplies(items).needs_reply).toHaveLength(1)
  })

  it('overview: counts come from rows', async () => {
    const o = await loadOverview(db)
    expect(o.companies).toBe(62)
    expect(o.contacts).toBe(5)
    expect(o.byStage.ready).toBe(1)
    expect(o.needsResearch).toBe(2)
    expect(o.needsVerificationCompanies).toBe(1)
    expect(o.unverifiedContacts).toBe(1)
    expect(o.readyToSend).toBe(2) // info@gemco + sales@ringbros (agency already replied)
    expect(o.inCampaigns).toBe(2)
    expect(o.repliesWaiting).toBe(1)
    expect(o.interested).toBe(1)
    expect(o.recent.length).toBeGreaterThan(0)
    expect(o.tasksActive).toBe(0)
  })

  it('facets list only stored values', async () => {
    const f = await leadFacets(db)
    expect(f.states).toEqual(['CA', 'MD', 'NY', 'PA'])
    expect(f.campaigns).toEqual(['Agencies A', 'Jewelers Q4'])
  })

  it('hrefs keep filters and reset the page', () => {
    const cur = q('view=verify&state=MD&page=3&sort=name')
    expect(leadsHref(cur, { filters: { stage: 'ready' } })).toBe('/leads?view=verify&state=MD&stage=ready&sort=name')
    expect(leadsHref(cur, { page: 4 })).toBe('/leads?view=verify&state=MD&sort=name&page=4')
    expect(leadsHref(cur, { view: 'table', filters: { state: undefined }, sort: 'updated', dir: 'desc' })).toBe('/leads')
  })
})
