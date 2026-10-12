import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'

// Viktor's #87 review (High): an Editor could mint agent API keys. A minted key
// works on /api/ops, so an editor could give themselves owner-level power.
// connect.ts, integrations.ts and agents.ts are now owner-only and write as the
// signed-in owner's own actor id.
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown, role: null as string | null, actor: 'owner' } }))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`)
  },
}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db, dbConfigured: () => Boolean(holder.db) }))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => holder.role,
  currentActorId: async () => holder.actor,
  currentEmail: async () => null,
}))

import { addAgentAction, mintKeyAction, revokeKeyAction, addChannelAction, setQuietShabbosAction } from '@/app/actions/connect'
import { upsertIntegrationAction } from '@/app/actions/integrations'
import { pauseAllAction, pauseAgentAction } from '@/app/actions/agents'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb
const as = (role: string | null, actor: string) => {
  holder.role = role
  holder.actor = actor
}
const form = (o: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}
const count = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n

beforeAll(async () => {
  db = await createTestDb()
  holder.db = db
  // A second human owner, so we can see the audit names the real person.
  await db.tx((q) => q.query(
    `insert into lp.actors (id, kind, display_name, email, role, active) values
       ('ed', 'human', 'Ed Itor', 'ed@example.com', 'editor', true),
       ('izzy', 'human', 'Izzy', 'izzy@example.com', 'owner', true)`,
  ), 'owner')
})
afterAll(async () => {
  holder.db = null
  await db.close()
})

describe('agents, keys and tools are owner-only', () => {
  it('an editor cannot mint, add an agent, revoke, add a channel or change quiet hours; nothing is written', async () => {
    as('editor', 'ed')
    const keys0 = await count(`select count(*)::int as n from lp.agent_keys`)
    const mint = await mintKeyAction(null, form({ actor_id: 'tab', label: 'sneaky' }))
    expect(mint.ok).toBe(false)
    expect(mint.secret).toBeUndefined()
    expect(mint.message).toBe('This needs owner access; you have editor access.')
    const add = await addAgentAction(null, form({ id: 'rogue', display_name: 'Rogue', kind: 'agent' }))
    expect(add.ok).toBe(false)
    const ch = await addChannelAction(null, form({ actor_id: 'tab', kind: 'webhook', url: 'https://example.com/hook' }))
    expect(ch.ok).toBe(false)
    await expect(revokeKeyAction(form({ actor_id: 'tab', key_id: '1', confirm: 'yes' }))).rejects.toThrow(/owner access/)
    await expect(setQuietShabbosAction(form({ actor_id: 'tab', on: 'false' }))).rejects.toThrow(/owner access/)
    expect(await count(`select count(*)::int as n from lp.agent_keys`)).toBe(keys0)
    expect(await count(`select count(*)::int as n from lp.actors where id = 'rogue'`)).toBe(0)
  })

  it('a viewer and a signed-out caller are refused too', async () => {
    as('viewer', 'ed')
    expect((await mintKeyAction(null, form({ actor_id: 'tab' }))).ok).toBe(false)
    as(null, 'owner')
    const r = await mintKeyAction(null, form({ actor_id: 'tab' }))
    expect(r.ok).toBe(false)
    expect(r.message).toBe('Not signed in.')
  })

  it('an editor cannot change the Tools hub or pause agents', async () => {
    as('editor', 'ed')
    await expect(upsertIntegrationAction(form({ id: 'rogue-tool', name: 'Rogue', kind: 'other', active: 'on' }))).rejects.toThrow(
      /REDIRECT:\/tools\?error=This%20needs%20owner%20access/,
    )
    expect(await count(`select count(*)::int as n from lp.integrations where id = 'rogue-tool'`)).toBe(0)
    await expect(pauseAllAction(form({ confirm: 'yes', reason: 'x' }))).rejects.toThrow(/owner access/)
    await expect(pauseAgentAction(form({ agent_id: 'tab', confirm: 'yes' }))).rejects.toThrow(/owner access/)
    expect(await count(`select count(*)::int as n from lp.agent_pause_all`)).toBe(0)
    expect(await count(`select count(*)::int as n from lp.actors where id = 'tab' and paused_at is not null`)).toBe(0)
  })

  it('an owner can mint a key, and the log names that owner, not a fixed owner', async () => {
    as('owner', 'izzy')
    const mint = await mintKeyAction(null, form({ actor_id: 'tab', label: 'runner' }))
    expect(mint.ok).toBe(true)
    expect(mint.secret).toBeTruthy()
    const k = await db.query<{ created_by: string }>(`select created_by from lp.agent_keys where actor_id = 'tab' and label = 'runner'`)
    expect(k.rows[0]?.created_by).toBe('izzy')
    await pauseAgentAction(form({ agent_id: 'tab', confirm: 'yes', reason: 'test' }))
    const p = await db.query<{ paused_by: string }>(`select paused_by from lp.actors where id = 'tab'`)
    expect(p.rows[0]?.paused_by).toBe('izzy')
  })
})
