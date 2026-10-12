/**
 * P2 follow-ups, sub-agent B (Instinct #86 findings 2 and 3), against real
 * Postgres via PGlite:
 *  - finding 2: the "table not migrated yet" fallback matches SQLSTATE 42P01
 *    only; a missing column (42703) or function (42883) is rethrown, not
 *    swallowed as an empty card.
 *  - finding 3: addLeadFile refuses a contact_id that is not a live contact of
 *    the given company (and a company that does not exist / was merged).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { isUndefinedTable, pgErrorCode, PG_UNDEFINED_TABLE } from '@/lib/db/errors'
import { addLeadFile, listLeadFiles, isMissingTable, FilesError } from '@/lib/leads/files'
import { LEAD_PROFILE_OPS } from '@/lib/leads/profile-ops'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

const pgErr = (code: string, message = 'boom') => Object.assign(new Error(message), { code })

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected the promise to reject')
}

describe('finding 2: isUndefinedTable / isMissingTable match SQLSTATE 42P01 only', () => {
  it('42P01 is a missing table', () => {
    expect(PG_UNDEFINED_TABLE).toBe('42P01')
    expect(isUndefinedTable(pgErr('42P01', 'relation "lp.files" does not exist'))).toBe(true)
    expect(isMissingTable(pgErr('42P01', 'relation "lp.files" does not exist'))).toBe(true)
  })

  it('a missing column (42703) or function (42883) is NOT a missing table', () => {
    expect(isMissingTable(pgErr('42703', 'column f.note does not exist'))).toBe(false)
    expect(isMissingTable(pgErr('42883', 'function lp.nope(integer) does not exist'))).toBe(false)
    expect(isMissingTable(pgErr('3F000', 'schema "lp" does not exist'))).toBe(false)
  })

  it('ignores the message: a code-less "does not exist" error is not matched', () => {
    expect(isMissingTable(new Error('relation "lp.files" does not exist'))).toBe(false)
    expect(isMissingTable(new Error('connection terminated unexpectedly'))).toBe(false)
    expect(isMissingTable(null)).toBe(false)
    expect(isMissingTable(undefined)).toBe(false)
    expect(isMissingTable('relation "x" does not exist')).toBe(false)
  })

  it('follows a wrapped error (cause chain)', () => {
    const wrapped = new Error('query failed', { cause: pgErr('42P01') })
    expect(pgErrorCode(wrapped)).toBe('42P01')
    expect(isMissingTable(wrapped)).toBe(true)
    expect(isMissingTable(new Error('query failed', { cause: pgErr('42703') }))).toBe(false)
  })

  it('a non-SQLSTATE code (e.g. a Node errno) is not treated as a SQLSTATE', () => {
    expect(pgErrorCode(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBeNull()
  })
})

describe('finding 2 against real Postgres (PGlite) errors', () => {
  let db: TestDb
  let co: number
  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Missing Bits Co' })
  }, 30_000)
  afterAll(async () => {
    await db.close()
  })

  it('PGlite puts 42P01 on a missing-table error, and it is matched', async () => {
    const e = await caught(db.query('select 1 from lp.no_such_table'))
    expect(pgErrorCode(e)).toBe('42P01')
    expect(isMissingTable(e)).toBe(true)
  })

  it('a missing column (42703) and a missing function (42883) are not matched', async () => {
    const col = await caught(db.query('select no_such_column from lp.companies'))
    expect(pgErrorCode(col)).toBe('42703')
    expect(isMissingTable(col)).toBe(false)
    const fn = await caught(db.query('select lp.no_such_function(1)'))
    expect(pgErrorCode(fn)).toBe('42883')
    expect(isMissingTable(fn)).toBe(false)
  })

  it('listLeadFiles returns [] when lp.files is missing, but rethrows a missing-column error', async () => {
    const fresh = await createTestDb()
    try {
      const c = await addCompany(fresh, { name: 'Half Migrated' })
      await fresh.query('alter table lp.files drop column note')
      // Old helper: "column f.note does not exist" matched /does not exist/ -> silently [].
      const e = await caught(listLeadFiles(fresh, c))
      expect(pgErrorCode(e)).toBe('42703')
      await fresh.query('drop table lp.files cascade')
      expect(await listLeadFiles(fresh, c)).toEqual([])
    } finally {
      await fresh.close()
    }
  }, 30_000)

  it('sanity: the healthy path still lists files', async () => {
    await addLeadFile(db, 'owner', { company_id: co, name: 'Spec sheet', url: 'https://example.com/spec' })
    expect((await listLeadFiles(db, co)).map((f) => f.name)).toContain('Spec sheet')
  })
})

describe('finding 3: addLeadFile checks the contact belongs to the company', () => {
  let db: TestDb
  let a: number
  let b: number
  let aContact: number
  let bContact: number
  beforeAll(async () => {
    db = await createTestDb()
    a = await addCompany(db, { name: 'Alpha Jewelers' })
    b = await addCompany(db, { name: 'Beta Jewelers' })
    aContact = await addContact(db, a, 'owner@alpha.example')
    bContact = await addContact(db, b, 'owner@beta.example')
  }, 30_000)
  afterAll(async () => {
    await db.close()
  })

  it("accepts the company's own contact", async () => {
    const f = await addLeadFile(db, 'owner', { company_id: a, contact_id: aContact, name: 'Signed form', url: 'https://example.com/a' })
    expect(Number(f.company_id)).toBe(a)
    expect(Number(f.contact_id)).toBe(aContact)
  })

  it('still accepts no contact_id (null or omitted)', async () => {
    const f1 = await addLeadFile(db, 'owner', { company_id: a, name: 'No contact', url: 'https://example.com/n' })
    expect(f1.contact_id).toBeNull()
    const f2 = await addLeadFile(db, 'owner', { company_id: a, contact_id: null, name: 'Null contact', url: 'https://example.com/n2' })
    expect(f2.contact_id).toBeNull()
  })

  it("refuses another company's contact, and writes nothing", async () => {
    const before = (await listLeadFiles(db, a)).length
    const e = await caught(addLeadFile(db, 'owner', { company_id: a, contact_id: bContact, name: 'Wrong', url: 'https://example.com/w' }))
    expect(e).toBeInstanceOf(FilesError)
    expect((e as FilesError).status).toBe(400)
    expect((e as FilesError).message).toMatch(/does not belong to lead/)
    expect((await listLeadFiles(db, a)).length).toBe(before)
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from lp.files where contact_id = $1`, [bContact])
    expect(rows[0].n).toBe(0)
  })

  it('refuses a contact that does not exist (clean 404, not a foreign-key 500)', async () => {
    const e = await caught(addLeadFile(db, 'owner', { company_id: a, contact_id: 99999999, name: 'Ghost', url: 'https://example.com/g' }))
    expect(e).toBeInstanceOf(FilesError)
    expect((e as FilesError).status).toBe(404)
    expect((e as FilesError).message).toMatch(/No contact 99999999/)
  })

  it('refuses a company that does not exist (clean 404)', async () => {
    const e = await caught(addLeadFile(db, 'owner', { company_id: 99999999, name: 'Ghost co', url: 'https://example.com/gc' }))
    expect(e).toBeInstanceOf(FilesError)
    expect((e as FilesError).status).toBe(404)
  })

  it('refuses a merged-away contact (merged_into set)', async () => {
    const dupe = await addContact(db, a, 'dupe@alpha.example')
    await db.query(`update lp.contacts set merged_into = $1, email_norm = null where id = $2`, [aContact, dupe])
    const e = await caught(addLeadFile(db, 'owner', { company_id: a, contact_id: dupe, name: 'Merged', url: 'https://example.com/m' }))
    expect(e).toBeInstanceOf(FilesError)
    expect((e as FilesError).status).toBe(409)
    expect((e as FilesError).message).toMatch(/merged into contact/)
  })

  it('the lead_files_add ops op surfaces the refusal as a plain OpsError with its status', async () => {
    const e = await caught(
      LEAD_PROFILE_OPS.lead_files_add.run(db, 'owner', { company_id: a, contact_id: bContact, name: 'Via ops', url: 'https://example.com/o' }),
    )
    expect(e).toBeInstanceOf(OpsError)
    expect((e as OpsError).status).toBe(400)
    expect((e as OpsError).message).toMatch(/does not belong to lead/)
    const ok = (await LEAD_PROFILE_OPS.lead_files_add.run(db, 'owner', {
      company_id: b,
      contact_id: bContact,
      name: 'Via ops ok',
      url: 'https://example.com/ok',
    })) as { contact_id: number }
    expect(Number(ok.contact_id)).toBe(bContact)
  })
})
