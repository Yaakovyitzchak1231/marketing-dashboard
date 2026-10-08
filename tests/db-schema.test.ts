import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from './helpers/pglite-db'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('lead platform schema (db/migrations)', () => {
  let db: TestDb
  beforeEach(async () => {
    db = await createTestDb()
  })
  afterEach(async () => {
    await db.close()
  })

  it('seeds the actors: the owner (human) and the agents', async () => {
    const { rows } = await db.query<{ id: string; kind: string }>('select id, kind from lp.actors order by id')
    const ids = rows.map((r) => r.id)
    expect(ids).toEqual(expect.arrayContaining(['owner', 'tab', 'hermes', 'claude', 'manus', 'system']))
    expect(rows.find((r) => r.id === 'owner')?.kind).toBe('human')
  })

  it('refuses a second company with the same website domain, phone, or name+address', async () => {
    await db.query("insert into lp.companies (name, website_domain, phone_e164, name_addr_key) values ('A', 'a.com', '+14105550100', 'a|baltimore|md')")
    await expect(db.query("insert into lp.companies (name, website_domain) values ('B', 'a.com')")).rejects.toThrow()
    await expect(db.query("insert into lp.companies (name, phone_e164) values ('B', '+14105550100')")).rejects.toThrow()
    await expect(db.query("insert into lp.companies (name, name_addr_key) values ('B', 'a|baltimore|md')")).rejects.toThrow()
    // Nulls never collide.
    await db.query("insert into lp.companies (name) values ('C'), ('D')")
  })

  it('keeps one contact per email', async () => {
    await db.query("insert into lp.contacts (email, email_norm) values ('Owner@A.com', 'owner@a.com')")
    await expect(db.query("insert into lp.contacts (email, email_norm) values ('owner@a.com', 'owner@a.com')")).rejects.toThrow()
  })

  it('writes status history by trigger, naming the actor of the transaction', async () => {
    const { rows } = await db.query<{ id: number }>("insert into lp.companies (name) values ('Gem Co') returning id")
    const id = rows[0].id
    await db.tx(async (q) => {
      await q.query("update lp.companies set stage = 'ready' where id = $1", [id])
    }, 'tab')
    const h = await db.query<{ old_value: string | null; new_value: string; changed_by: string | null }>(
      "select old_value, new_value, changed_by from lp.status_history where entity_type = 'company' and entity_id = $1 order by id",
      [id],
    )
    expect(h.rows).toEqual([
      { old_value: null, new_value: 'new', changed_by: null },
      { old_value: 'new', new_value: 'ready', changed_by: 'tab' },
    ])
  })

  it('makes the activity log append-only', async () => {
    await db.query("insert into lp.events (actor, kind, summary) values ('tab', 'test', 'hello')")
    await expect(db.query("update lp.events set summary = 'changed'")).rejects.toThrow(/append-only/)
    await expect(db.query('delete from lp.events')).rejects.toThrow(/append-only/)
  })

  it('allows only one live task per dedupe key, but a new one after it finishes', async () => {
    await db.query("insert into lp.tasks (kind, title, dedupe_key) values ('research_company', 'r', 'research:1')")
    await expect(db.query("insert into lp.tasks (kind, title, dedupe_key) values ('research_company', 'r', 'research:1')")).rejects.toThrow()
    await db.query("update lp.tasks set status = 'done' where dedupe_key = 'research:1'")
    await db.query("insert into lp.tasks (kind, title, dedupe_key) values ('research_company', 'r', 'research:1')")
  })
})
