import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestDb } from './helpers/pglite-db'
import { comment, createTask, handoffTask, sendMessage, markRead } from '@/lib/ops/core'
import { ackDeliveries, addChannel, dispatchDue, feed, MAX_DISPATCH_BATCH, setChannelEnabled } from '@/lib/notify/deliver'
import { addActor } from '@/lib/notify/keys'

let db: Awaited<ReturnType<typeof createTestDb>>
beforeEach(async () => { db = await createTestDb() })
afterEach(async () => { await db.close() })
const migration = readFileSync(join(__dirname, '..', 'db/migrations/0016_agent_feed_access.sql'), 'utf8')
async function migrateAgain() {
  for (const sql of migration.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await db.query(sql)
}
const future = () => new Date(Date.now() + 86400_000)

describe('legacy agent delivery recovery', () => {
  it('backfills Tab assignments, messages, handoffs and mentions idempotently without mail', async () => {
    // Recreate the production email-only state in this isolated in-memory database.
    await db.query("delete from lp.delivery_channels where actor_id = 'tab' and kind = 'pull'")
    const task = await createTask(db, 'owner', { title: 'Legacy assignment', assigned_to: 'tab' })
    await sendMessage(db, 'hermes', { to: 'tab', body: 'Please check the task' })
    await handoffTask(db, 'owner', task.id, { to: 'tab', note: 'Continue here' })
    await comment(db, 'hermes', { task_id: task.id, body: '@tab check this evidence' })
    expect(await feed(db, 'tab')).toEqual([])
    await migrateAgain(); await migrateAgain()
    const channels = await db.query("select id from lp.delivery_channels where actor_id = 'tab' and kind = 'pull'")
    expect(channels.rows).toHaveLength(1)
    const items = await feed(db, 'tab')
    expect(items.map((e) => e.kind).sort()).toEqual(['assigned', 'handoff', 'mention', 'message'])
    expect(await feed(db, 'tab')).toEqual([])
    await ackDeliveries(db, 'tab', items.map((e) => e.delivery_id))
    expect(await feed(db, 'tab', { now: future() })).toEqual([])
  })

  it('does not reenable deliberately disabled fetch channels or add channels to humans/internal actors', async () => {
    await db.query("update lp.delivery_channels set enabled = false where actor_id = 'hermes'")
    await migrateAgain()
    const channels = await db.query<{ enabled: boolean }>("select enabled from lp.delivery_channels where actor_id = 'hermes'")
    expect(channels.rows).toEqual([{ enabled: false }])
    expect((await db.query("select id from lp.delivery_channels where actor_id in ('owner','system','instantly-ai')")).rows).toHaveLength(0)
  })

  it('does not replay read or already acknowledged notifications during backfill', async () => {
    await db.query("delete from lp.delivery_channels where actor_id = 'tab' and kind = 'pull'")
    await createTask(db, 'owner', { title: 'Already read', assigned_to: 'tab' })
    await markRead(db, 'tab')
    await createTask(db, 'owner', { title: 'Already received', assigned_to: 'tab' })
    const rows = await db.query<{ id: number }>("select id from lp.deliveries where recipient = 'tab'")
    await ackDeliveries(db, 'tab', rows.rows.map((r) => r.id))
    await migrateAgain()
    expect(await feed(db, 'tab')).toEqual([])
  })
})

describe('bounded dispatch and disabled channels', () => {
  it('never dispatches or offers queued work through a disabled channel', async () => {
    const channel = await addChannel(db, 'owner', { actor_id: 'hermes', kind: 'webhook', url: 'https://agent.example/hook' })
    await createTask(db, 'owner', { title: 'Disabled delivery', assigned_to: 'hermes' })
    await setChannelEnabled(db, 'owner', channel.id, false)
    await db.query("update lp.delivery_channels set enabled = false where actor_id = 'hermes' and kind = 'pull'")
    const result = await dispatchDue(db, { now: future(), fetchImpl: async () => { throw new Error('must not send') } })
    expect(result.picked).toBe(0)
    expect(await feed(db, 'hermes')).toEqual([])
    expect((await db.query<{ attempts: number }>("select attempts from lp.deliveries where recipient = 'hermes'")).rows.every((r) => r.attempts === 0)).toBe(true)
  })

  it('caps the batch and concurrent network calls, retaining overflow for the next dispatch', async () => {
    await addActor(db, 'owner', { id: 'batch-agent', display_name: 'Batch' })
    await addChannel(db, 'owner', { actor_id: 'batch-agent', kind: 'webhook', url: 'https://agent.example/hook' })
    for (let i = 0; i < MAX_DISPATCH_BATCH + 3; i++) await createTask(db, 'owner', { title: `Task ${i}`, assigned_to: 'batch-agent' })
    let active = 0; let peak = 0
    const fetchImpl = async () => {
      active++; peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return new Response('ok')
    }
    const result = await dispatchDue(db, { now: future(), limit: 1000, fetchImpl })
    expect(result.picked).toBe(MAX_DISPATCH_BATCH)
    expect(result.delivered).toBe(MAX_DISPATCH_BATCH)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(5)
    expect((await dispatchDue(db, { now: future(), fetchImpl })).delivered).toBe(3)
  })

  it('an acknowledgement during a push is not overwritten by its later settlement', async () => {
    await addChannel(db, 'owner', { actor_id: 'hermes', kind: 'ntfy' })
    await createTask(db, 'owner', { title: 'Ack race', assigned_to: 'hermes' })
    const rows = await db.query<{ id: number }>("select id from lp.deliveries where recipient = 'hermes' order by id")
    await dispatchDue(db, { now: future(), fetchImpl: async () => {
      await ackDeliveries(db, 'hermes', [rows.rows[0].id])
      return new Response('ok')
    } })
    expect((await db.query<{ status: string }>("select status from lp.deliveries where recipient = 'hermes'")).rows.every((r) => r.status === 'delivered')).toBe(true)
  })

  it('multiple fetch channels still offer a notification only once per retry window', async () => {
    await addChannel(db, 'owner', { actor_id: 'hermes', kind: 'mcp' })
    await addChannel(db, 'owner', { actor_id: 'hermes', kind: 'stream' })
    await createTask(db, 'owner', { title: 'One event', assigned_to: 'hermes' })
    const first = await feed(db, 'hermes')
    expect(first).toHaveLength(1)
    expect(await feed(db, 'hermes')).toEqual([])
    expect(await feed(db, 'hermes', { now: future() })).toHaveLength(1)
  })
})
