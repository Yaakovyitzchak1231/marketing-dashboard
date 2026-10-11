import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { findCompanyCandidates, findContactCandidates } from '@/lib/merge/candidates'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('lib/merge/candidates', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it('finds company candidates by recomputed domain, phone and name+address key, not for distinct rows', async () => {
    // domain: both set the SAME stored website_domain, which the unique index would block --
    // so give them raw websites that normalize to the same domain but store differently (drift).
    const a = await addCompany(db, { name: 'Bright Gems', city: 'Austin', state: 'TX' })
    const b = await addCompany(db, { name: 'Bright Gems Jewelry', city: 'Austin', state: 'TX' })
    await db.query(`update lp.companies set website = 'https://www.brightgems.example/' where id = $1`, [a])
    await db.query(`update lp.companies set website = 'http://BrightGems.example' where id = $1`, [b])

    // phone: same story -- raw phone strings differ, normalize the same.
    const p1 = await addCompany(db, { name: 'Ring House' })
    const p2 = await addCompany(db, { name: 'Ring House NYC' })
    await db.query(`update lp.companies set phone = '(212) 555-0101' where id = $1`, [p1])
    await db.query(`update lp.companies set phone = '+1 212.555.0101' where id = $1`, [p2])

    // name+address: same name/city/state, different casing/punctuation.
    const n1 = await addCompany(db, { name: 'The Old Town Jewelry Co.', city: 'Denver', state: 'CO' })
    const n2 = await addCompany(db, { name: 'old town jewelry', city: 'Denver', state: 'CO' })

    // a distinct row that must NOT show up as a candidate of anything above.
    await addCompany(db, { name: 'Unrelated Store', city: 'Miami', state: 'FL', domain: 'unrelated.example' })

    const domainCands = await findCompanyCandidates(db, 50)
    const domainPair = domainCands.find((c) => c.rules.includes('domain') && new Set([c.a.id, c.b.id]).has(a) && new Set([c.a.id, c.b.id]).has(b))
    expect(domainPair).toBeTruthy()

    const phonePair = domainCands.find((c) => c.rules.includes('phone') && new Set([c.a.id, c.b.id]).has(p1) && new Set([c.a.id, c.b.id]).has(p2))
    expect(phonePair).toBeTruthy()

    const namePair = domainCands.find((c) => c.rules.includes('name_addr') && new Set([c.a.id, c.b.id]).has(n1) && new Set([c.a.id, c.b.id]).has(n2))
    expect(namePair).toBeTruthy()

    // The distinct row never pairs with anything.
    for (const c of domainCands) {
      expect([c.a.name, c.b.name]).not.toContain('Unrelated Store')
    }
  })

  it('excludes already-merged companies from candidates', async () => {
    const x = await addCompany(db, { name: 'Merged Away', domain: 'mergedaway.example' })
    const y = await addCompany(db, { name: 'Merged Away Two' })
    await db.query(`update lp.companies set website = 'https://mergedaway.example' where id = $1`, [y])
    await db.query(`update lp.companies set merged_into = $1, website_domain = null where id = $2`, [x, y])
    const cands = await findCompanyCandidates(db, 200)
    expect(cands.some((c) => c.a.id === y || c.b.id === y)).toBe(false)
  })

  it('finds contact candidates by recomputed email across two different companies', async () => {
    const co1 = await addCompany(db, { name: 'Co One' })
    const co2 = await addCompany(db, { name: 'Co Two' })
    const ct1 = await addContact(db, co1, 'Shared@Example.com')
    await db.query(`update lp.contacts set email = 'shared@example.com', email_norm = null where id = $1`, [ct1]) // normalized column drifted away
    const ct2 = await addContact(db, co2, 'shared@example.com')
    await addContact(db, co1, 'distinct@example.com')

    const cands = await findContactCandidates(db, 50)
    const pair = cands.find((c) => new Set([c.a.id, c.b.id]).has(ct1) && new Set([c.a.id, c.b.id]).has(ct2))
    expect(pair).toBeTruthy()
    expect(pair?.rules).toEqual(['email'])
    for (const c of cands) expect([c.a.id, c.b.id]).not.toContain(undefined)
  })
})
