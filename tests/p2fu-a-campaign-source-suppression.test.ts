import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { runOp } from '@/lib/ops/dispatch'
import { createCampaign } from '@/lib/campaigns/store'
import { parseCampaignPatch } from '@/lib/campaigns/types'
import { addSuppression } from '@/lib/suppressions/store'

// Instinct #86 finding 1: the segment -> campaign suppression check looked at one
// (first-added) contact per company. Membership is company-level, so ANY live
// contact being suppressed / do-not-contact must keep the company out; merged-away
// contacts are ignored; emails are normalized before the lookup.

type TestDb = Awaited<ReturnType<typeof createTestDb>>
type Result = { matching: number; added: number; skipped_by_rule: number; skipped_suppressed: number; skipped_excluded: number }

describe('campaign_add_from_segment checks every contact of a company (finding 1)', () => {
  let db: TestDb
  let campaignId: number
  const ids: Record<string, number> = {}

  beforeAll(async () => {
    db = await createTestDb()
    const co = (name: string) => addCompany(db, { name, state: 'VT', stage: 'new' })

    // Clean first contact, suppressed second contact -> excluded.
    ids.second = await co('Second Contact Co')
    await addContact(db, ids.second, 'owner@second.example', 'valid')
    await addContact(db, ids.second, 'buyer@second.example', 'valid')
    await addSuppression(db, 'tab', { email: 'buyer@second.example', reason: 'unsubscribed' })

    // Mixed-case address on a legacy row with no email_norm; suppressed in lower case -> excluded.
    ids.mixed = await co('Mixed Case Co')
    await db.query(`insert into lp.contacts (company_id, email, email_norm, verification_status) values ($1, '  Bob@Example.COM ', null, 'valid')`, [ids.mixed])
    await addSuppression(db, 'tab', { email: 'bob@example.com', reason: 'manual' })

    // Suppressed upper-case form, contact stored in another case -> excluded.
    ids.upper = await co('Upper Suppression Co')
    await addContact(db, ids.upper, 'Ann@Upper.example', 'valid')
    await addSuppression(db, 'tab', { email: 'ANN@UPPER.EXAMPLE', reason: 'manual' })

    // Second contact marked do-not-contact (flag) -> excluded.
    ids.dncFlag = await co('DNC Flag Co')
    await addContact(db, ids.dncFlag, 'a@dncflag.example', 'valid')
    const flagged = await addContact(db, ids.dncFlag, 'b@dncflag.example', 'valid')
    await db.query('update lp.contacts set do_not_contact = true where id = $1', [flagged])

    // Contact with status 'do-not-contact' -> excluded.
    ids.dncStatus = await co('DNC Status Co')
    await addContact(db, ids.dncStatus, 'a@dncstatus.example', 'valid')
    await addContact(db, ids.dncStatus, 'b@dncstatus.example', 'valid', { status: 'do-not-contact' })

    // The only suppressed / do-not-contact contacts are merged away into a contact at
    // another company -> ignored, company is added.
    const survivorCo = await addCompany(db, { name: 'Survivor Co', state: 'NH', stage: 'new' })
    const survivor = await addContact(db, survivorCo, 'keeper@survivor.example', 'valid')
    ids.merged = await co('Merged Contact Co')
    await addContact(db, ids.merged, 'live@merged.example', 'valid')
    const gone = await addContact(db, ids.merged, 'gone@merged.example', 'valid')
    const goneDnc = await addContact(db, ids.merged, 'gone2@merged.example', 'valid')
    await addSuppression(db, 'tab', { email: 'gone@merged.example', reason: 'bounced' })
    await db.query('update lp.contacts set merged_into = $2 where id = $1', [gone, survivor])
    await db.query('update lp.contacts set merged_into = $2, do_not_contact = true where id = $1', [goneDnc, survivor])

    // Clean multi-contact company and a company with no contacts -> both added.
    ids.clean = await co('Clean Co')
    await addContact(db, ids.clean, 'one@clean.example', 'valid')
    await addContact(db, ids.clean, 'Two@Clean.example', 'valid')
    ids.noContacts = await co('No Contacts Co')

    const c = await createCampaign(db, 'owner', parseCampaignPatch({ name: 'P2FU-A', pool: 'jeweler' }, { create: true }) as { name: string })
    campaignId = c.id
  })
  afterAll(async () => {
    await db.close()
  })

  it('excludes a company when any live contact is suppressed or do-not-contact; ignores merged contacts', async () => {
    const source = (await runOp(db, 'tab', 'create_segment', {
      name: 'VT leads',
      entity: 'company',
      kind: 'dynamic',
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'VT' }] }] },
    })) as { id: number }

    const r = (await runOp(db, 'owner', 'campaign_add_from_segment', { campaign_id: campaignId, segment_id: source.id })) as Result
    expect(r.matching).toBe(8)
    expect(r.skipped_by_rule).toBe(0)
    expect(r.skipped_excluded).toBe(0)
    expect(r.skipped_suppressed).toBe(5)
    expect(r.added).toBe(3)

    const { rows } = await db.query<{ company_id: number }>('select company_id from lp.campaign_leads where campaign_id = $1 order by company_id', [campaignId])
    expect(rows.map((m) => Number(m.company_id))).toEqual([ids.merged, ids.clean, ids.noContacts].sort((a, b) => a - b))
  })

  it('a campaign-scoped suppression on a non-primary contact only blocks that campaign', async () => {
    const coId = await addCompany(db, { name: 'Scoped Co', state: 'ME', stage: 'new' })
    await addContact(db, coId, 'first@scoped.example', 'valid')
    await addContact(db, coId, 'Second@Scoped.example', 'valid')
    const other = await createCampaign(db, 'owner', parseCampaignPatch({ name: 'P2FU-A other', pool: 'jeweler' }, { create: true }) as { name: string })
    await addSuppression(db, 'tab', { email: 'second@scoped.example', reason: 'manual', campaign_id: campaignId })
    const seg = (await runOp(db, 'tab', 'create_segment', {
      name: 'ME leads',
      entity: 'company',
      kind: 'dynamic',
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'ME' }] }] },
    })) as { id: number }

    const blocked = (await runOp(db, 'owner', 'campaign_add_from_segment', { campaign_id: campaignId, segment_id: seg.id })) as Result
    expect(blocked.skipped_suppressed).toBe(1)
    expect(blocked.added).toBe(0)

    const allowed = (await runOp(db, 'owner', 'campaign_add_from_segment', { campaign_id: other.id, segment_id: seg.id })) as Result
    expect(allowed.skipped_suppressed).toBe(0)
    expect(allowed.added).toBe(1)
  })
})
