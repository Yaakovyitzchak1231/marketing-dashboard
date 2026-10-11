import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact, addTouch } from './helpers/lead-fixtures'
import { MergeError, merge } from '@/lib/merge/merge'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('lib/merge/merge', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it('merges two companies: moves events/contacts/touches, applies field choices, soft-deletes the loser, writes merge_log + status_history', async () => {
    const keep = await addCompany(db, { name: 'Bright Gems', city: 'Austin', state: 'TX', owner_name: null })
    const loser = await addCompany(db, { name: 'Bright Gems Jewelry', city: 'Austin', state: 'TX', owner_name: 'Maria Lopez' })
    const ctKeep = await addContact(db, keep, 'info@brightgems.example')
    const ctLoser = await addContact(db, loser, 'maria@brightgems.example')
    await addTouch(db, { companyId: loser, event: 'email_sent', at: '2026-01-01T00:00:00Z', campaign: 'Spring' })
    await db.query(`insert into lp.comments (company_id, author, body) values ($1, 'owner', 'a note on the loser')`, [loser])
    await db.query(`insert into lp.tasks (title, kind, company_id, created_by) values ('follow up', 'general', $1, 'owner')`, [loser])

    const result = await merge(db, 'owner', { entity: 'company', keep, merge: loser, choices: { owner_name: 'merge' } })
    expect(result.kept_id).toBe(keep)
    expect(result.merged_id).toBe(loser)
    expect(result.fields_applied.owner_name).toBe('Maria Lopez')

    const { rows: kept } = await db.query('select owner_name, merged_into from lp.companies where id = $1', [keep])
    expect(kept[0].owner_name).toBe('Maria Lopez')
    expect(kept[0].merged_into).toBeNull()
    const { rows: gone } = await db.query('select merged_into from lp.companies where id = $1', [loser])
    expect(Number(gone[0].merged_into)).toBe(keep)

    const { rows: contacts } = await db.query<{ company_id: number }>('select company_id from lp.contacts where id in ($1,$2)', [ctKeep, ctLoser])
    expect(contacts.every((c: { company_id: number }) => Number(c.company_id) === keep)).toBe(true)

    const { rows: touches } = await db.query('select company_id from lp.campaign_touches where company_id = $1', [keep])
    expect(touches.length).toBeGreaterThan(0)
    const { rows: comments } = await db.query('select company_id from lp.comments where company_id = $1', [keep])
    expect(comments.length).toBeGreaterThan(0)
    const { rows: tasks } = await db.query('select company_id from lp.tasks where company_id = $1', [keep])
    expect(tasks.length).toBeGreaterThan(0)

    const { rows: log } = await db.query('select entity, kept_id, merged_id, field_choices, actor from lp.merge_log')
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ entity: 'company', kept_id: keep, merged_id: loser, actor: 'owner' })
    expect(log[0].field_choices).toEqual({ owner_name: 'merge' })

    const { rows: hist } = await db.query("select field, changed_by, via from lp.status_history where entity_type = 'company' and entity_id = $1 and field = 'merge'", [keep])
    expect(hist).toHaveLength(1)
    expect(hist[0].changed_by).toBe('owner')
  })

  it('rejects a self-merge and a double-merge', async () => {
    const a = await addCompany(db, { name: 'Self Co' })
    await expect(merge(db, 'owner', { entity: 'company', keep: a, merge: a })).rejects.toThrow(MergeError)

    const keep = await addCompany(db, { name: 'K' })
    const loser = await addCompany(db, { name: 'L' })
    const third = await addCompany(db, { name: 'T' })
    await merge(db, 'owner', { entity: 'company', keep, merge: loser })
    await expect(merge(db, 'owner', { entity: 'company', keep: third, merge: loser })).rejects.toThrow(/already merged/)
    await expect(merge(db, 'owner', { entity: 'company', keep: loser, merge: third })).rejects.toThrow(/already merged/)
  })

  it('merging companies that each have a contact at the same email does not collide (contacts email stays globally unique)', async () => {
    const keep = await addCompany(db, { name: 'Dup Email Keep' })
    const loser = await addCompany(db, { name: 'Dup Email Loser' })
    await addContact(db, keep, 'shared@example.com')
    // same company's worth of distinct contact, different email, moves cleanly
    await addContact(db, loser, 'other@example.com')
    const result = await merge(db, 'owner', { entity: 'company', keep, merge: loser })
    expect(result.kept_id).toBe(keep)
    const { rows } = await db.query('select count(*)::int as n from lp.contacts where company_id = $1 and merged_into is null', [keep])
    expect(Number(rows[0].n)).toBe(2)
  })

  it('merges two contacts: moves verification/touches/enrichment, applies choices, soft-deletes the loser', async () => {
    const co = await addCompany(db, { name: 'One Store' })
    const keep = await addContact(db, co, 'keep@example.com')
    const loser = await addContact(db, co, 'loser@example.com')
    await db.query(`update lp.contacts set first_name = 'Loser-First' where id = $1`, [loser])
    await db.query(`insert into lp.verification_results (contact_id, email, provider, result, verdict) values ($1, 'loser@example.com', 'manual', 'ok', 'valid')`, [loser])
    await db.query(`insert into lp.enrichment (company_id, contact_id, field, value, method) values ($1, $2, 'personalization', 'likes golf', 'manual')`, [co, loser])
    await addTouch(db, { companyId: co, contactId: loser, event: 'email_sent', at: '2026-01-01T00:00:00Z' })

    const result = await merge(db, 'owner', { entity: 'contact', keep, merge: loser, choices: { first_name: 'merge' } })
    expect(result.fields_applied.first_name).toBe('Loser-First')

    const { rows: vr } = await db.query('select contact_id from lp.verification_results where contact_id = $1', [keep])
    expect(vr.length).toBeGreaterThan(0)
    const { rows: er } = await db.query<{ contact_id: number | null }>('select contact_id from lp.enrichment where company_id = $1', [co])
    expect(er.every((r: { contact_id: number | null }) => Number(r.contact_id) === keep)).toBe(true)
    const { rows: tr } = await db.query<{ contact_id: number }>('select contact_id from lp.campaign_touches where company_id = $1', [co])
    expect(tr.length).toBeGreaterThan(0)
    expect(tr.every((r: { contact_id: number }) => Number(r.contact_id) === keep)).toBe(true)
    const { rows: gone } = await db.query('select merged_into, email_norm from lp.contacts where id = $1', [loser])
    expect(Number(gone[0].merged_into)).toBe(keep)
    expect(gone[0].email_norm).toBeNull()
  })
})
