import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { addCompaniesToList, companyLists, listStaticLists, removeCompanyFromList, ListsError } from '@/lib/segments/lists'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('static lists (plan 2.4)', () => {
  let db: TestDb
  let leadA: number
  let leadB: number

  beforeAll(async () => {
    db = await createTestDb()
    leadA = await addCompany(db, { name: 'List Lead A', state: 'NY' })
    leadB = await addCompany(db, { name: 'List Lead B', state: 'NJ' })
  })
  afterAll(async () => {
    await db.close()
  })

  it('creates a new list on first add, and reuses it by id on a second add', async () => {
    const r1 = await addCompaniesToList(db, 'owner', { newListName: 'Trade show' }, [leadA])
    expect(r1.added).toBe(1)
    const lists1 = await companyLists(db, leadA)
    expect(lists1.map((l) => l.name)).toEqual(['Trade show'])

    const r2 = await addCompaniesToList(db, 'owner', { listId: r1.list.id }, [leadB])
    expect(r2.added).toBe(1)
    expect(r2.list.id).toBe(r1.list.id)
    const all = await listStaticLists(db)
    expect(all.filter((l) => l.name === 'Trade show').length).toBe(1) // not duplicated

    // Re-adding the same lead is a no-op (segment_add_members' own on-conflict-do-nothing).
    const r3 = await addCompaniesToList(db, 'owner', { listId: r1.list.id }, [leadA])
    expect(r3.added).toBe(0)
  })

  it('removes a lead from a list', async () => {
    const lists = await companyLists(db, leadA)
    await removeCompanyFromList(db, 'owner', lists[0].id, leadA)
    expect(await companyLists(db, leadA)).toEqual([])
    // leadB is still in it.
    expect((await companyLists(db, leadB)).length).toBe(1)
  })

  it('refuses with no leads, no name, and an unknown list', async () => {
    await expect(addCompaniesToList(db, 'owner', { newListName: 'x' }, [])).rejects.toThrow(ListsError)
    await expect(addCompaniesToList(db, 'owner', {}, [leadA])).rejects.toThrow(ListsError)
    await expect(addCompaniesToList(db, 'owner', { listId: 999999 }, [leadA])).rejects.toThrow(ListsError)
  })
})
