import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import {
  SuppressionError,
  addSuppression,
  checkEmails,
  exportCsv,
  importCsv,
  liftSuppression,
  listSuppressions,
  normalizeDomain,
  normalizeEmail,
} from '@/lib/suppressions/store'

describe('normalization', () => {
  it('lower-cases and trims emails and domains', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com')
    expect(normalizeDomain(' Competitor.COM ')).toBe('competitor.com')
    expect(normalizeDomain('https://www.Competitor.com/pricing')).toBe('competitor.com')
  })
})

describe('lib/suppressions/store', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it('adds an email suppression, rejects a bad address, and is idempotent', async () => {
    const row = await addSuppression(db, 'owner', { email: ' Bounce@Old.com ', reason: 'bounced', note: 'from a webhook' })
    expect(row.email_norm).toBe('bounce@old.com')
    expect(row.domain).toBeNull()
    expect(row.reason).toBe('bounced')
    const again = await addSuppression(db, 'owner', { email: 'bounce@old.com', reason: 'bounced' })
    expect(again.id).toBe(row.id) // idempotent: the existing live row, not a duplicate
    const { rows } = await db.query('select count(*)::int as n from lp.suppressions where email_norm = $1', ['bounce@old.com'])
    expect(Number(rows[0].n)).toBe(1)

    await expect(addSuppression(db, 'owner', { email: 'not-an-email', reason: 'manual' })).rejects.toThrow(SuppressionError)
    await expect(addSuppression(db, 'owner', { reason: 'manual' })).rejects.toThrow(/email or a domain/)
    await expect(addSuppression(db, 'owner', { email: 'a@b.com', domain: 'c.com', reason: 'manual' })).rejects.toThrow(/not both/)
    await expect(addSuppression(db, 'owner', { email: 'x@y.com', reason: 'not_a_real_reason' })).rejects.toThrow(/reason must be/)

    const { rows: hist } = await db.query("select * from lp.status_history where entity_type = 'suppression' and entity_id = $1", [row.id])
    expect(hist).toHaveLength(1)
    expect(hist[0].via).toBe('ui')
  })

  it('adds a domain suppression and matches any address at that domain', async () => {
    const row = await addSuppression(db, 'owner', { domain: 'Competitor.COM', reason: 'competitor' })
    expect(row.domain).toBe('competitor.com')
    expect(row.email_norm).toBeNull()
    const check = await checkEmails(db, ['sales@competitor.com'])
    expect(check['sales@competitor.com']).toEqual({ suppressed: true, by: { id: row.id, kind: 'domain', reason: 'competitor', campaign_id: null } })
  })

  it('per-campaign suppression applies only to that campaign; global applies to all', async () => {
    const { rows: camps } = await db.query<{ id: number }>(
      `insert into lp.campaigns (name, pool, status, created_by, updated_by) values ('A', 'jeweler', 'draft', 'owner', 'owner'), ('B', 'jeweler', 'draft', 'owner', 'owner') returning id`,
    )
    const [campA, campB] = camps.map((c) => Number(c.id))
    await addSuppression(db, 'owner', { email: 'only-camp-a@x.com', reason: 'do_not_contact', campaign_id: campA })
    const forCampA = await checkEmails(db, ['only-camp-a@x.com'], campA)
    const forCampB = await checkEmails(db, ['only-camp-a@x.com'], campB)
    const global = await checkEmails(db, ['only-camp-a@x.com'])
    expect(forCampA['only-camp-a@x.com'].suppressed).toBe(true)
    expect(forCampB['only-camp-a@x.com'].suppressed).toBe(false)
    expect(global['only-camp-a@x.com'].suppressed).toBe(false)

    await addSuppression(db, 'owner', { email: 'everywhere@x.com', reason: 'legal' })
    expect((await checkEmails(db, ['everywhere@x.com'], campA))['everywhere@x.com'].suppressed).toBe(true)
    expect((await checkEmails(db, ['everywhere@x.com'], campB))['everywhere@x.com'].suppressed).toBe(true)
    expect((await checkEmails(db, ['everywhere@x.com']))['everywhere@x.com'].suppressed).toBe(true)
  })

  it('a lifted suppression is ignored; lifting twice (or lifting nothing) fails honestly', async () => {
    const row = await addSuppression(db, 'owner', { email: 'lift-me@x.com', reason: 'manual' })
    expect((await checkEmails(db, ['lift-me@x.com']))['lift-me@x.com'].suppressed).toBe(true)
    const lifted = await liftSuppression(db, 'owner', { id: row.id })
    expect(lifted.lifted_at).not.toBeNull()
    expect(lifted.lifted_by).toBe('owner')
    expect((await checkEmails(db, ['lift-me@x.com']))['lift-me@x.com'].suppressed).toBe(false)
    await expect(liftSuppression(db, 'owner', { id: row.id })).rejects.toThrow(SuppressionError)
    await expect(liftSuppression(db, 'owner', { email: 'never-added@x.com' })).rejects.toThrow(/No live suppression/)
    // adding again after a lift makes a fresh live row (not blocked by the lifted one)
    const row2 = await addSuppression(db, 'owner', { email: 'lift-me@x.com', reason: 'manual' })
    expect(row2.id).not.toBe(row.id)
  })

  it('an expired suppression is ignored', async () => {
    await addSuppression(db, 'owner', { email: 'expired@x.com', reason: 'manual', expires_at: '2020-01-01T00:00:00Z' })
    expect((await checkEmails(db, ['expired@x.com']))['expired@x.com'].suppressed).toBe(false)
    await addSuppression(db, 'owner', { email: 'future@x.com', reason: 'manual', expires_at: '2099-01-01T00:00:00Z' })
    expect((await checkEmails(db, ['future@x.com']))['future@x.com'].suppressed).toBe(true)
  })

  it('checkEmails answers a whole batch, including unmatched and duplicate emails, honestly', async () => {
    await addSuppression(db, 'owner', { email: 'batch1@x.com', reason: 'manual' })
    const checks = await checkEmails(db, ['batch1@x.com', 'BATCH1@X.COM', 'clean@x.com', 'batch1@x.com'])
    expect(checks['batch1@x.com'].suppressed).toBe(true)
    expect(checks['BATCH1@X.COM'].suppressed).toBe(true)
    expect(checks['clean@x.com']).toEqual({ suppressed: false, by: null })
  })

  it('writes a lead_events "suppressed" row when the email matches a known contact', async () => {
    const co = await addCompany(db, { name: 'Has A Contact' })
    await addContact(db, co, 'known@hascontact.com', 'valid')
    await addSuppression(db, 'owner', { email: 'known@hascontact.com', reason: 'unsubscribed', source: 'instantly_webhook' })
    const { rows } = await db.query("select type, company_id, props from lp.lead_events where type = 'suppressed' and email_norm = 'known@hascontact.com'")
    expect(rows).toHaveLength(1)
    expect(rows[0].company_id).toBe(co)
  })

  it('listSuppressions filters by q, reason and campaign, and excludes lifted unless asked', async () => {
    const r = await addSuppression(db, 'owner', { email: 'listed-only@filterme.com', reason: 'legal' })
    const byQ = await listSuppressions(db, { q: 'filterme' })
    expect(byQ.rows.some((x) => x.id === r.id)).toBe(true)
    const byReason = await listSuppressions(db, { reason: 'legal', q: 'filterme' })
    expect(byReason.rows.every((x) => x.reason === 'legal')).toBe(true)
    await liftSuppression(db, 'owner', { id: r.id })
    expect((await listSuppressions(db, { q: 'filterme' })).rows.some((x) => x.id === r.id)).toBe(false)
    expect((await listSuppressions(db, { q: 'filterme', include_lifted: true })).rows.some((x) => x.id === r.id)).toBe(true)
  })

  it('CSV round-trip: export reads back what was imported', async () => {
    const csv = 'email,domain,reason,note\ncsv1@import.com,,unsubscribed,from a CSV\n,csv-domain.com,competitor,\n'
    const result = await importCsv(db, 'owner', csv, { source: 'import' })
    expect(result.rows).toBe(2)
    expect(result.added).toBe(2)
    const again = await importCsv(db, 'owner', csv, { source: 'import' })
    expect(again.added).toBe(0)
    expect(again.already).toBe(2)
    const out = await exportCsv(db, { q: 'import.com' })
    expect(out).toContain('csv1@import.com,,,unsubscribed,import,from a CSV')
    const domainOut = await exportCsv(db, { q: 'csv-domain' })
    expect(domainOut).toContain(',csv-domain.com,,competitor,import')
  })

  it('CSV import reports a bad row without failing the whole file', async () => {
    const csv = 'email,reason\nok@good.com,manual\n,manual\n'
    const result = await importCsv(db, 'owner', csv, { source: 'import' })
    expect(result.added).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].row).toBe(3)
  })
})
