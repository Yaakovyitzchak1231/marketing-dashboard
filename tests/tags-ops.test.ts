import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { addTag, listTags, mergeTags, removeTag, renameTag, setTagStyle, tagTrends } from '@/lib/tags/store'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('tags as first-class (plan 2.9)', () => {
  let db: TestDb
  let c1: number
  let c2: number
  let c3: number

  beforeAll(async () => {
    db = await createTestDb()
    c1 = await addCompany(db, { name: 'Tag Co 1' })
    c2 = await addCompany(db, { name: 'Tag Co 2' })
    c3 = await addCompany(db, { name: 'Tag Co 3' })
  })
  afterAll(async () => {
    await db.close()
  })

  it('add_tag / remove_tag round-trip, emitting tag_added / tag_removed events', async () => {
    await addTag(db, 'claude', { company_id: c1, tag: 'vip' })
    await addTag(db, 'claude', { company_id: c2, tag: 'vip' })
    let tags = await listTags(db)
    expect(tags.find((t) => t.tag === 'vip')?.count).toBe(2)

    const addedEvents = await db.query(`select 1 from lp.lead_events where type = 'tag_added' and company_id = $1`, [c1])
    expect(addedEvents.rows).toHaveLength(1)

    await removeTag(db, 'claude', { company_id: c1, tag: 'vip' })
    tags = await listTags(db)
    expect(tags.find((t) => t.tag === 'vip')?.count).toBe(1)
    const removedEvents = await db.query(`select 1 from lp.lead_events where type = 'tag_removed' and company_id = $1`, [c1])
    expect(removedEvents.rows).toHaveLength(1)

    // adding the same tag twice does not duplicate it in the array
    await addTag(db, 'claude', { company_id: c2, tag: 'vip' })
    const { rows } = await db.query<{ tags: string[] }>(`select tags from lp.companies where id = $1`, [c2])
    expect(rows[0].tags.filter((t) => t === 'vip')).toHaveLength(1)
  })

  it('set_tag_style creates/updates colour + description', async () => {
    const styled = await setTagStyle(db, 'claude', { tag: 'vip', colour: '#4f7cff', description: 'High-value lead' })
    expect(styled).toMatchObject({ tag: 'vip', colour: '#4f7cff', description: 'High-value lead' })
    await expect(setTagStyle(db, 'claude', { tag: 'vip', colour: 'not-a-colour' })).rejects.toThrow()
  })

  it('rename_tag updates every company row, is audited, and carries the old styling to the new name', async () => {
    const result = await renameTag(db, 'claude', { from: 'vip', to: 'priority' })
    expect(result.companies_updated).toBe(1) // only c2 has "vip" at this point
    const tags = await listTags(db)
    expect(tags.find((t) => t.tag === 'vip')).toBeUndefined()
    const priority = tags.find((t) => t.tag === 'priority')
    expect(priority?.count).toBe(1)
    expect(priority?.colour).toBe('#4f7cff') // styling carried over from "vip"

    const hist = await db.query(`select * from lp.status_history where entity_type = 'tag' and entity_key = 'vip' and field = 'rename'`)
    expect(hist.rows).toHaveLength(1)

    const { rows: c2rows } = await db.query<{ tags: string[] }>(`select tags from lp.companies where id = $1`, [c2])
    expect(c2rows[0].tags).toContain('priority')
    expect(c2rows[0].tags).not.toContain('vip')
  })

  it('merge_tags combines several tags into one target tag across every affected company', async () => {
    await addTag(db, 'claude', { company_id: c1, tag: 'hot_lead' })
    await addTag(db, 'claude', { company_id: c3, tag: 'warm_lead' })
    await addTag(db, 'claude', { company_id: c2, tag: 'hot_lead' }) // c2 already has "priority" too

    const result = await mergeTags(db, 'claude', { tags: ['hot_lead', 'warm_lead'], into: 'engaged' })
    expect(result.companies_updated).toBe(3)
    const tags = await listTags(db)
    expect(tags.find((t) => t.tag === 'hot_lead')).toBeUndefined()
    expect(tags.find((t) => t.tag === 'warm_lead')).toBeUndefined()
    expect(tags.find((t) => t.tag === 'engaged')?.count).toBe(3)

    const hist = await db.query(`select * from lp.status_history where entity_type = 'tag' and entity_key = 'engaged' and field = 'merge'`)
    expect(hist.rows).toHaveLength(1)

    // c2 keeps "priority" and now has "engaged" instead of "hot_lead", with no duplicates
    const { rows: c2rows } = await db.query<{ tags: string[] }>(`select tags from lp.companies where id = $1`, [c2])
    expect(c2rows[0].tags.sort()).toEqual(['engaged', 'priority'])
  })

  it('tag_trends counts tag_added events per week', async () => {
    const trends = await tagTrends(db, 52)
    const engaged = trends.filter((t) => t.tag === 'engaged')
    expect(engaged.reduce((acc, t) => acc + t.added, 0)).toBe(3)
  })

  it('ops door: list_tags / rename_tag / merge_tags / set_tag_style / tag_trends are wired, and reject bad input', async () => {
    const tags = await runOp(db, 'claude', 'list_tags', {})
    expect(Array.isArray(tags)).toBe(true)
    await expect(runOp(db, 'claude', 'merge_tags', { tags: [], into: 'x' })).rejects.toBeInstanceOf(OpsError)
    await expect(runOp(db, 'claude', 'rename_tag', { from: 'engaged', to: 'engaged' })).rejects.toBeInstanceOf(OpsError)
    const trend = await runOp(db, 'claude', 'tag_trends', { weeks: 4 })
    expect(Array.isArray(trend)).toBe(true)
  })
})
