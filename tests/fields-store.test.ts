import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { FieldError, archiveField, defineField, listFieldDefs, updateField } from '@/lib/fields/store'
import { updateEntity } from '@/lib/edit/update'

describe('lib/fields/store', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it('defines a field, rejects a bad key/type, and is case-insensitive on duplicate keys', async () => {
    const f = await defineField(db, 'owner', { entity: 'company', key: 'store_size', label: 'Store size', type: 'number' })
    expect(f.entity).toBe('company')
    expect(f.key).toBe('store_size')
    expect(f.type).toBe('number')

    await expect(defineField(db, 'owner', { entity: 'company', key: 'store_size', label: 'Dup', type: 'text' })).rejects.toThrow(FieldError)
    await expect(defineField(db, 'owner', { entity: 'company', key: 'Bad Key!', label: 'x', type: 'text' })).rejects.toThrow(/slug/)
    await expect(defineField(db, 'owner', { entity: 'planet', key: 'x', label: 'x', type: 'text' })).rejects.toThrow(/entity must be/)
    await expect(defineField(db, 'owner', { entity: 'company', key: 'x', label: 'x', type: 'not_a_type' })).rejects.toThrow(/type must be/)
    await expect(defineField(db, 'owner', { entity: 'company', key: 'opts', label: 'Opts', type: 'select' })).rejects.toThrow(/at least one option/)

    const { rows: hist } = await db.query("select * from lp.status_history where entity_type = 'field_def' and entity_id = $1", [f.id])
    expect(hist).toHaveLength(1)
    expect(hist[0].field).toBe('defined')
  })

  it('defines a select field with options, lists fields, and archives one', async () => {
    const sel = await defineField(db, 'owner', { entity: 'contact', key: 'ring_brand', label: 'Ring brand', type: 'select', options: ['Tacori', 'Verragio', ' Tacori '] })
    expect(sel.options).toEqual(['Tacori', 'Verragio']) // de-duped, trimmed

    const all = await listFieldDefs(db, { entity: 'contact' })
    expect(all.find((f) => f.key === 'ring_brand')).toBeTruthy()

    const archived = await archiveField(db, 'owner', { id: sel.id })
    expect(archived.archived_at).not.toBeNull()
    const live = await listFieldDefs(db, { entity: 'contact' })
    expect(live.find((f) => f.key === 'ring_brand')).toBeUndefined()
    const withArchived = await listFieldDefs(db, { entity: 'contact', include_archived: true })
    expect(withArchived.find((f) => f.key === 'ring_brand')).toBeTruthy()

    // the key is free again once archived
    const redefined = await defineField(db, 'owner', { entity: 'contact', key: 'ring_brand', label: 'Ring brand v2', type: 'text' })
    expect(redefined.label).toBe('Ring brand v2')

    const { rows: hist } = await db.query<{ field: string }>("select * from lp.status_history where entity_type = 'field_def' and entity_id = $1 order by id", [sel.id])
    expect(hist.map((h) => h.field)).toEqual(['defined', 'archived'])
  })

  it('updateField renames and changes options, but not type or key', async () => {
    const f = await defineField(db, 'owner', { entity: 'company', key: 'rating', label: 'Rating', type: 'select', options: ['A', 'B'] })
    const renamed = await updateField(db, 'owner', { id: f.id, label: 'Google rating' })
    expect(renamed.label).toBe('Google rating')
    const reopts = await updateField(db, 'owner', { id: f.id, options: ['A', 'B', 'C'] })
    expect(reopts.options).toEqual(['A', 'B', 'C'])
    expect(reopts.type).toBe('select') // unchanged -- update_field has no `type` input at all
  })

  it('value validation: number rejects non-numeric text, select rejects an unknown option -- via update_entity', async () => {
    const companyId = await addCompany(db, { name: 'Acme Jewelers' })
    await defineField(db, 'owner', { entity: 'company', key: 'sq_ft', label: 'Square feet', type: 'number' })
    await defineField(db, 'owner', { entity: 'company', key: 'tier', label: 'Tier', type: 'select', options: ['gold', 'silver'] })

    const r1 = await updateEntity(db, 'owner', { type: 'company', id: companyId, field: 'custom.sq_ft', value: '1200', via: 'ui' })
    expect(r1.changed).toBe(true)
    expect(r1.field).toBe('custom.sq_ft')

    await expect(updateEntity(db, 'owner', { type: 'company', id: companyId, field: 'custom.sq_ft', value: 'abc', via: 'ui' })).rejects.toThrow(/must be a number/)
    await expect(updateEntity(db, 'owner', { type: 'company', id: companyId, field: 'custom.tier', value: 'platinum', via: 'ui' })).rejects.toThrow(/must be one of/)
    await expect(updateEntity(db, 'owner', { type: 'company', id: companyId, field: 'custom.not_a_field', value: 'x', via: 'ui' })).rejects.toThrow(/not a defined/)
    await expect(updateEntity(db, 'owner', { type: 'campaign', id: 1, field: 'custom.x', value: 'x', via: 'ui' })).rejects.toThrow(/only on company or contact/)

    const ok = await updateEntity(db, 'owner', { type: 'company', id: companyId, field: 'custom.tier', value: 'gold', via: 'ui' })
    expect(ok.changed).toBe(true)
    const { rows } = await db.query<{ custom: Record<string, unknown> }>('select custom from lp.companies where id = $1', [companyId])
    expect(rows[0].custom).toEqual({ sq_ft: 1200, tier: 'gold' })

    // a no-op write (same value) is not a change, and writes no second audit row
    const again = await updateEntity(db, 'owner', { type: 'company', id: companyId, field: 'custom.tier', value: 'gold', via: 'ui' })
    expect(again.changed).toBe(false)
    const { rows: hist } = await db.query("select * from lp.status_history where entity_type = 'company' and entity_id = $1 and field = 'custom.tier'", [companyId])
    expect(hist).toHaveLength(1)
  })

  it('a contact custom field writes to contacts.custom, not companies.custom', async () => {
    const companyId = await addCompany(db, { name: 'Bright Jewelers' })
    const contactId = await addContact(db, companyId, 'sara@bright.example')
    await defineField(db, 'owner', { entity: 'contact', key: 'last_trade_show', label: 'Last trade show', type: 'date' })
    await updateEntity(db, 'owner', { type: 'contact', id: contactId, field: 'custom.last_trade_show', value: '2026-06-01', via: 'ui' })
    const { rows } = await db.query<{ custom: Record<string, unknown> }>('select custom from lp.contacts where id = $1', [contactId])
    expect(rows[0].custom).toEqual({ last_trade_show: '2026-06-01' })
    await expect(updateEntity(db, 'owner', { type: 'contact', id: contactId, field: 'custom.last_trade_show', value: 'not-a-date', via: 'ui' })).rejects.toThrow(/must be a date/)
  })

  it('boolean and multi_select validate and normalize', async () => {
    const companyId = await addCompany(db, { name: 'Multi Co' })
    await defineField(db, 'owner', { entity: 'company', key: 'is_vip', label: 'VIP', type: 'boolean' })
    await defineField(db, 'owner', { entity: 'company', key: 'brands', label: 'Brands', type: 'multi_select', options: ['A', 'B', 'C'] })
    await updateEntity(db, 'owner', { type: 'company', id: companyId, field: 'custom.is_vip', value: 'yes', via: 'ui' })
    await updateEntity(db, 'owner', { type: 'company', id: companyId, field: 'custom.brands', value: 'A, B', via: 'ui' })
    const { rows } = await db.query<{ custom: Record<string, unknown> }>('select custom from lp.companies where id = $1', [companyId])
    expect(rows[0].custom.is_vip).toBe(true)
    expect(rows[0].custom.brands).toEqual(['A', 'B'])
    await expect(updateEntity(db, 'owner', { type: 'company', id: companyId, field: 'custom.brands', value: 'A, Z', via: 'ui' })).rejects.toThrow(/not one of/)
  })
})
