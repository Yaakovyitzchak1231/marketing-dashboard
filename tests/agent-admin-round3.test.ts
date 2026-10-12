import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown, role: 'owner' as string | null, actor: 'owner' } }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => holder.role,
  currentActorId: async () => holder.actor,
  currentEmail: async () => null,
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { to })
  },
}))
import { createTestDb } from './helpers/pglite-db'
import { renameAgentAction, setAgentCanSendAction } from '@/app/actions/agents'
type TestDb = Awaited<ReturnType<typeof createTestDb>>

const fd = (fields: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

describe('agent settings round 3 (row 6, Kilo review)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    holder.db = db
  })
  afterAll(async () => db.close())

  it('a whitespace-only rename comes back as a note on the agent page, not the error page', async () => {
    const e = (await renameAgentAction(fd({ agent_id: 'tab', display_name: '   ' })).catch((x) => x)) as { to?: string }
    expect(e.to).toBe(`/agents/tab?tone=bad&note=${encodeURIComponent('Give the agent a name.')}`)
    const { rows } = await db.query<{ display_name: string }>("select display_name from lp.actors where id = 'tab'")
    expect(rows[0].display_name.trim()).not.toBe('')
  })

  it('a refusal on a person or built-in actor is a note too', async () => {
    const e = (await setAgentCanSendAction(fd({ agent_id: 'owner', can_send: 'true' })).catch((x) => x)) as { to?: string }
    expect(e.to).toMatch(/^\/agents\/owner\?tone=bad&note=/)
  })

  it('a valid rename still saves and returns normally', async () => {
    await expect(renameAgentAction(fd({ agent_id: 'tab', display_name: 'Tab Prime' }))).resolves.toBeUndefined()
    const { rows } = await db.query<{ display_name: string }>("select display_name from lp.actors where id = 'tab'")
    expect(rows[0].display_name).toBe('Tab Prime')
  })

})
