import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { compileSegment, countSegment, matchingIds } from '@/lib/segments/compile'
import { validateDefinition } from '@/lib/segments/definition'
import { listPresets, getPreset } from '@/lib/segments/presets'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function emitEvent(
  db: TestDb,
  opts: { type: string; companyId?: number | null; contactId?: number | null; occurredAt: string },
) {
  await db.query(
    `insert into lp.lead_events (occurred_at, type, company_id, contact_id, source, props) values ($1, $2, $3, $4, 'test', '{}')`,
    [opts.occurredAt, opts.type, opts.companyId ?? null, opts.contactId ?? null],
  )
}

const DAYS = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

describe('starter segment presets (plan 2.3)', () => {
  it('every preset validates (the DSL accepts it as-is)', () => {
    for (const p of listPresets()) {
      expect(() => validateDefinition(p.definition)).not.toThrow()
    }
  })

  it('getPreset looks one up by key, and null for an unknown key', () => {
    expect(getPreset('engaged')?.label).toBe('Engaged')
    expect(getPreset('not-a-real-preset')).toBeNull()
  })

  it('"Hot by score" is omitted until a score field is registered', () => {
    expect(listPresets().some((p) => p.key === 'hot_by_score')).toBe(false)
  })

  describe('each preset compiles against real data with the expected count', () => {
    let db: TestDb
    let quietContact: number
    let activeContact: number

    beforeAll(async () => {
      db = await createTestDb()

      // engaged: opened, no reply
      const engagedCo = await addCompany(db, { name: 'Engaged Co', domain: 'engaged.example' })
      const engagedContact = await addContact(db, engagedCo, 'e@engaged.example', 'valid')
      await emitEvent(db, { type: 'email_opened', contactId: engagedContact, occurredAt: DAYS(1) })

      // replied_positive: lead_interested
      const repliedCo = await addCompany(db, { name: 'Replied Co', domain: 'replied.example' })
      const repliedContact = await addContact(db, repliedCo, 'r@replied.example', 'valid')
      await emitEvent(db, { type: 'lead_interested', contactId: repliedContact, occurredAt: DAYS(2) })
      // also engaged (opened) so it would ALSO match "engaged" if it hadn't replied -- but it has
      // no reply_received event, only lead_interested, so it still matches "engaged" too; fine,
      // presets overlap by design (a contact can be in more than one segment).

      // gone_quiet: sent, nothing since (beyond 45d)
      const quietCo = await addCompany(db, { name: 'Quiet Co', domain: 'quiet.example' })
      quietContact = await addContact(db, quietCo, 'q@quiet.example', 'valid')
      await emitEvent(db, { type: 'email_sent', contactId: quietContact, occurredAt: DAYS(90) })
      await emitEvent(db, { type: 'email_opened', contactId: quietContact, occurredAt: DAYS(80) })

      // still active in the last 45 days -- should NOT be "gone quiet"
      const activeCo = await addCompany(db, { name: 'Active Co', domain: 'active.example' })
      activeContact = await addContact(db, activeCo, 'a@active.example', 'valid')
      await emitEvent(db, { type: 'email_sent', contactId: activeContact, occurredAt: DAYS(10) })
      await emitEvent(db, { type: 'email_opened', contactId: activeContact, occurredAt: DAYS(5) })

      // never_opened_after_3: sent 3x, never opened
      const neverOpenedCo = await addCompany(db, { name: 'Never Opened Co', domain: 'neveropened.example' })
      const neverOpenedContact = await addContact(db, neverOpenedCo, 'n@neveropened.example', 'valid')
      for (let i = 0; i < 3; i++) await emitEvent(db, { type: 'email_sent', contactId: neverOpenedContact, occurredAt: DAYS(5 + i) })

      // bounced
      const bouncedCo = await addCompany(db, { name: 'Bounced Co', domain: 'bounced.example' })
      const bouncedContact = await addContact(db, bouncedCo, 'b@bounced.example', 'valid')
      await emitEvent(db, { type: 'email_bounced', contactId: bouncedContact, occurredAt: DAYS(3) })

      // ready_never_contacted
      await addCompany(db, { name: 'Ready Co', stage: 'ready', domain: 'ready.example' })

      // owner_known_verified
      const ownerVerifiedCo = await addCompany(db, { name: 'Owner Co', owner_name: 'Jane Owner', domain: 'owner.example' })
      await addContact(db, ownerVerifiedCo, 'o@owner.example', 'valid')
    })

    afterAll(async () => {
      await db.close()
    })

    async function countsFor(key: string) {
      const preset = getPreset(key)
      if (!preset) throw new Error(`no preset ${key}`)
      const compiled = await compileSegment(db, preset.definition)
      return countSegment(db, compiled)
    }

    it('engaged: opened, no reply', async () => {
      const c = await countsFor('engaged')
      expect(c.contacts).toBeGreaterThanOrEqual(1)
    })

    it('replied_positive: marked interested', async () => {
      const c = await countsFor('replied_positive')
      expect(c.contacts).toBe(1)
    })

    it('gone_quiet: quiet for 45+ days, excludes the still-active one', async () => {
      const preset = getPreset('gone_quiet')!
      const compiled = await compileSegment(db, preset.definition)
      const ids = await matchingIds(db, compiled)
      expect(ids).toContain(quietContact)
      expect(ids).not.toContain(activeContact)
    })

    it('never_opened_after_3: sent 3x, never opened', async () => {
      const c = await countsFor('never_opened_after_3')
      expect(c.contacts).toBe(1)
    })

    it('bounced: at least one bounce', async () => {
      const c = await countsFor('bounced')
      expect(c.contacts).toBe(1)
    })

    it('ready_never_contacted: stage ready, no campaign', async () => {
      const c = await countsFor('ready_never_contacted')
      expect(c.companies).toBeGreaterThanOrEqual(1)
    })

    it('owner_known_verified: owner set, a verified-sendable contact', async () => {
      const c = await countsFor('owner_known_verified')
      expect(c.companies).toBe(1)
    })
  })
})
