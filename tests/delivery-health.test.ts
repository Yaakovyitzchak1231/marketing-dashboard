import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { readDeliveryHealth } from '@/lib/notify/health'
import { createTask } from '@/lib/ops/core'

let db: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.close() })

describe('read-only delivery health', () => {
  it('distinguishes unavailable data from measured zero', async () => {
    expect(await readDeliveryHealth(null)).toMatchObject({ available: false })
    expect(await readDeliveryHealth({ query: async () => { throw new Error('secret connection details') } }))
      .toEqual({ available: false, error: 'Delivery health is unavailable. Check the database connection and notification migrations.' })
  })
  it('reports stored unread counts and safe channel kinds without message bodies or config', async () => {
    await createTask(db, 'owner', { title: 'private task content', assigned_to: 'tab' })
    const health = await readDeliveryHealth(db)
    expect(health.available).toBe(true)
    if (!health.available) throw new Error('missing health')
    expect(health.agents.find((a) => a.id === 'tab')).toMatchObject({ unread: 1, failed: 0 })
    expect(health.agents.find((a) => a.id === 'hermes')).toMatchObject({ unread: 0, last_seen_at: null })
    const serialized = JSON.stringify(health)
    expect(serialized).not.toContain('private task content')
    expect(serialized).not.toContain('mail.tab.bot')
    expect(serialized).not.toContain('secret')
  })
})
