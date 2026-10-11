import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { compileSegment, countSegment, matchingIds } from '@/lib/segments/compile'
import { DefinitionError } from '@/lib/segments/definition'
import { createSegment } from '@/lib/segments/store'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function emitEvent(
  db: TestDb,
  opts: { type: string; companyId?: number | null; contactId?: number | null; occurredAt: string; props?: Record<string, unknown> },
) {
  await db.query(
    `insert into lp.lead_events (occurred_at, type, company_id, contact_id, source, props) values ($1, $2, $3, $4, 'test', $5)`,
    [opts.occurredAt, opts.type, opts.companyId ?? null, opts.contactId ?? null, JSON.stringify(opts.props ?? {})],
  )
}

async function countsFor(db: TestDb, definition: unknown) {
  const compiled = await compileSegment(db, definition)
  return countSegment(db, compiled)
}

describe('segment compiler (PGlite, real schema)', () => {
  let db: TestDb
  // New York, verified, replied 0 times in 30d
  let nyGoodCo: number
  // New Jersey, verified, replied once recently (should be excluded by "replies=0")
  let njRepliedCo: number
  // California, unverified
  let caCo: number
  let activeCampaignId: number
  let draftCampaignId: number

  beforeAll(async () => {
    db = await createTestDb()

    nyGoodCo = await addCompany(db, { name: 'NY Good Co', state: 'NY', stage: 'ready', domain: 'nygood.example' })
    const nyContact = await addContact(db, nyGoodCo, 'owner@nygood.example', 'valid')
    void nyContact

    njRepliedCo = await addCompany(db, { name: 'NJ Replied Co', state: 'NJ', stage: 'contacted', domain: 'njreplied.example' })
    const njContact = await addContact(db, njRepliedCo, 'owner@njreplied.example', 'valid')
    await emitEvent(db, { type: 'reply_received', companyId: njRepliedCo, contactId: njContact, occurredAt: new Date().toISOString() })
    await emitEvent(db, { type: 'email_link_clicked', companyId: njRepliedCo, contactId: njContact, occurredAt: new Date().toISOString(), props: { url: 'https://example.com/pricing' } })

    caCo = await addCompany(db, { name: 'CA Co', state: 'CA', stage: 'new', domain: 'ca.example' })
    await addContact(db, caCo, 'owner@ca.example', 'unverified')

    const { rows: campRows } = await db.query<{ id: number }>(
      `insert into lp.campaigns (name, status) values ('Active Camp', 'active'), ('Draft Camp', 'draft') returning id`,
    )
    activeCampaignId = campRows[0].id
    draftCampaignId = campRows[1].id
    await db.query(`insert into lp.campaign_leads (campaign_id, company_id) values ($1, $2)`, [activeCampaignId, njRepliedCo])
  })

  afterAll(async () => {
    await db.close()
  })

  it('field operator "is" / "in" over company.state', async () => {
    const isCounts = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'NY' }] }] })
    expect(isCounts.companies).toBe(1)
    const inCounts = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'in', value: ['NY', 'NJ'] }] }] })
    expect(inCounts.companies).toBe(2)
    const notInCounts = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'not_in', value: ['NY', 'NJ'] }] }] })
    expect(notInCounts.companies).toBe(1)
  })

  it('field operator "contains" / "exists"', async () => {
    const containsCounts = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.name', op: 'contains', value: 'Good' }] }] })
    expect(containsCounts.companies).toBe(1)
    const existsCounts = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.website_domain', op: 'exists' }] }] })
    expect(existsCounts.companies).toBe(3)
  })

  it('AND within a group, OR across groups (include)', async () => {
    // (state=NY and stage=ready) OR (state=CA) -> NY Good Co + CA Co = 2
    const counts = await countsFor(db, {
      entity: 'company',
      include: [
        { conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'NY' }, { kind: 'field', field: 'company.stage', op: 'is', value: 'ready' }] },
        { conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'CA' }] },
      ],
    })
    expect(counts.companies).toBe(2)
  })

  it('exclude block subtracts from include', async () => {
    const counts = await countsFor(db, {
      entity: 'company',
      include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'in', value: ['NY', 'NJ'] }] }],
      exclude: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'NJ' }] }],
    })
    expect(counts.companies).toBe(1)
  })

  it('event condition: replies = 0 in the last 30 days (excludes the company that replied)', async () => {
    const counts = await countsFor(db, {
      entity: 'company',
      include: [{ conditions: [{ kind: 'event', event_type: 'reply_received', count_op: 'eq', count: 0, within_last_days: 30 }] }],
    })
    // nyGoodCo (0 replies) and caCo (0 replies) match; njRepliedCo does not.
    expect(counts.companies).toBe(2)
  })

  it('event condition: opened >= 3 in last 14 days', async () => {
    const contact = await addContact(db, nyGoodCo, 'extra@nygood.example', 'valid')
    for (let i = 0; i < 3; i++) await emitEvent(db, { type: 'email_opened', companyId: nyGoodCo, contactId: contact, occurredAt: new Date().toISOString() })
    const counts = await countsFor(db, {
      entity: 'company',
      include: [{ conditions: [{ kind: 'field', field: 'company.name', op: 'is', value: 'NY Good Co' }, { kind: 'event', event_type: 'email_opened', count_op: 'gte', count: 3, within_last_days: 14 }] }],
    })
    expect(counts.companies).toBe(1)
  })

  it('event prop filter: link clicked containing /pricing', async () => {
    const counts = await countsFor(db, {
      entity: 'company',
      include: [{ conditions: [{ kind: 'event', event_type: 'email_link_clicked', count_op: 'gte', count: 1, prop: { path: 'props.url', op: 'contains', value: '/pricing' } }] }],
    })
    expect(counts.companies).toBe(1)
  })

  it('relative_date: contact verified more than 0 days after company created (sanity on the comparison direction)', async () => {
    const counts = await countsFor(db, {
      entity: 'contact',
      include: [{ conditions: [{ kind: 'field', field: 'contact.verification_status', op: 'is', value: 'valid' }] }],
      exclude: [],
    })
    expect(counts.contacts).toBeGreaterThan(0)
    // field "within_last_days" / "more_than_days_ago" on a date field, sanity check both directions
    const recent = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.created_at', op: 'within_last_days', value: 365 }] }] })
    expect(recent.companies).toBe(3)
    const old = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.created_at', op: 'more_than_days_ago', value: 365 }] }] })
    expect(old.companies).toBe(0)
  })

  it('campaign_membership: in_campaign, any_active_campaign, never_contacted', async () => {
    const inCamp = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'campaign_membership', mode: 'in_campaign', campaign_id: activeCampaignId }] }] })
    expect(inCamp.companies).toBe(1)
    const anyActive = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'campaign_membership', mode: 'any_active_campaign' }] }] })
    expect(anyActive.companies).toBe(1)
    const never = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'campaign_membership', mode: 'never_contacted' }] }] })
    expect(never.companies).toBe(2)
    void draftCampaignId
  })

  it('quality: verified_sendable vs suppressed', async () => {
    const sendable = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'quality', op: 'verified_sendable' }] }] })
    expect(sendable.companies).toBe(2) // nyGoodCo + njRepliedCo have a 'valid' contact; caCo does not
    await db.query(`insert into lp.suppressions (email_norm, reason, source) values ('owner@ca.example', 'manual', 'manual')`)
    const suppressed = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'quality', op: 'suppressed' }] }] })
    expect(suppressed.companies).toBe(1)
  })

  it('campaign-scoped segment: campaign_id on the segment itself is a store concern, not a compile concern (sanity: create + fetch)', async () => {
    const seg = await createSegment(db, 'tab', {
      name: 'Active campaign leads',
      entity: 'company',
      campaign_id: activeCampaignId,
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'campaign_membership', mode: 'in_campaign', campaign_id: activeCampaignId }] }] },
    })
    expect(seg.campaign_id).toBe(activeCampaignId)
  })

  it('segment-in-segment: in_segment references another segment; a self-reference is rejected as a cycle', async () => {
    const base = await createSegment(db, 'tab', {
      name: 'Base: NY or NJ',
      entity: 'company',
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'in', value: ['NY', 'NJ'] }] }] },
    })
    const counts = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'in_segment', segment_id: base.id }] }] })
    expect(counts.companies).toBe(2)
    const notIn = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'not_in_segment', segment_id: base.id }] }] })
    expect(notIn.companies).toBe(1)

    // A segment that includes itself: compile should reject the cycle, not loop forever.
    const selfRef = await createSegment(db, 'tab', {
      name: 'Self referencing (will be mutated to point at itself)',
      entity: 'company',
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'NY' }] }] },
    })
    await db.query(`update lp.segments set definition = $2 where id = $1`, [
      selfRef.id,
      JSON.stringify({ entity: 'company', include: [{ conditions: [{ kind: 'in_segment', segment_id: selfRef.id }] }] }),
    ])
    await expect(
      compileSegment(db, { entity: 'company', include: [{ conditions: [{ kind: 'in_segment', segment_id: selfRef.id }] }] }),
    ).rejects.toThrow(DefinitionError)
  })

  it('unknown field is rejected at compile time too (a stored definition is re-validated, not trusted blindly)', async () => {
    await expect(compileSegment(db, { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.nope', op: 'is', value: 'x' }] }] })).rejects.toThrow(DefinitionError)
  })

  it('an injection-looking value stays a bound parameter, never SQL text (no crash, no effect beyond matching the literal value)', async () => {
    const evil = "x'); drop table lp.companies; --"
    const counts = await countsFor(db, { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.name', op: 'is', value: evil }] }] })
    expect(counts.companies).toBe(0)
    // The table is still there and still has all 3 companies (the "attempt" was a no-op).
    const { rows } = await db.query<{ n: string }>('select count(*)::text as n from lp.companies')
    expect(Number(rows[0].n)).toBe(3)
  })

  it('counts match a hand-computed fixture: companies, contacts and verified-sendable for a definition', async () => {
    const compiled = await compileSegment(db, { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'in', value: ['NY', 'NJ'] }] }] })
    const counts = await countSegment(db, compiled)
    // Hand count: NY Good Co (2 contacts, 2 valid) + NJ Replied Co (1 contact, 1 valid) = 3 contacts, 3 companies... entity is company here so companies=2
    expect(counts.companies).toBe(2)
    expect(counts.contacts).toBe(3)
    expect(counts.verified_sendable).toBe(3)
    const ids = await matchingIds(db, compiled)
    expect(ids.sort((a, b) => a - b)).toEqual([nyGoodCo, njRepliedCo].sort((a, b) => a - b))
  })
})
