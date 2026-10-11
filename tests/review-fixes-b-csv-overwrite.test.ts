import { describe, it, expect, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { defineField } from '@/lib/fields/store'
import { runCsvImport } from '@/lib/leads/csv-import'

// Review fix 8b (real-data e2e test): a CSV import overwrote an existing contact's name,
// title and custom fields with no audit row (contact "Nimish" became "Bob", unrecoverable).
describe('CSV import never silently overwrites existing values (8b)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  afterAll(async () => db?.close())

  it('fills only empty fields by default; overwrite replaces and audits the old value', async () => {
    db = await createTestDb()
    await defineField(db, 'owner', { entity: 'contact', key: 'referral', label: 'Referral', type: 'text' })
    const mapping = { email: 'email', first: 'first_name', last: 'last_name', title: 'title', ref: 'contact_custom.referral' }
    await runCsvImport(db, [{ email: 'n@shop.test', first: 'Nimish', last: '', title: '', ref: 'friend' }], { mapping, actor: 'owner', dryRun: false })

    // Default: "Nimish" and "friend" stay; empty last_name and title get filled.
    const second = await runCsvImport(db, [{ email: 'n@shop.test', first: 'Bob', last: 'Shah', title: 'Owner', ref: 'ad' }], { mapping, actor: 'owner', dryRun: false })
    expect(second.would_update).toBe(1)
    const get = async () =>
      (await db.query<{ id: number; first_name: string; last_name: string; title: string; custom: Record<string, unknown> }>(
        `select id, first_name, last_name, title, custom from lp.contacts where email_norm = 'n@shop.test'`,
      )).rows[0]
    let c = await get()
    expect(c.first_name).toBe('Nimish')
    expect(c.last_name).toBe('Shah')
    expect(c.title).toBe('Owner')
    expect(c.custom.referral).toBe('friend')

    // overwrite: true replaces, and every replaced value is in the audit log with its old value.
    await runCsvImport(db, [{ email: 'n@shop.test', first: 'Bob', last: 'Shah', title: 'Owner', ref: 'ad' }], { mapping, actor: 'owner', dryRun: false, overwrite: true })
    c = await get()
    expect(c.first_name).toBe('Bob')
    expect(c.custom.referral).toBe('ad')
    const { rows: audit } = await db.query<{ field: string; old_value: string; new_value: string; via: string }>(
      `select field, old_value, new_value, via from lp.status_history where entity_type = 'contact' and entity_id = $1 and via = 'import' order by id`,
      [c.id],
    )
    expect(audit).toEqual([
      { field: 'first_name', old_value: 'Nimish', new_value: 'Bob', via: 'import' },
      { field: 'custom.referral', old_value: 'friend', new_value: 'ad', via: 'import' },
    ])
  })
})
