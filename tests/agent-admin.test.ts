import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb } from './helpers/pglite-db'

vi.mock('server-only', () => ({}))

import { listDisabledAgents, renameAgent, setAgentActive, setAgentCanSend } from '@/lib/ops/agents-admin'
import { listActors, actorDetail } from '@/lib/ops/queries'
import { agentForDbKey, mintAgentKey } from '@/lib/notify/keys'
import { getActor } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb
beforeEach(async () => { db = await createTestDb() })
afterEach(async () => { await db.close() })

const events = async (kind: string) =>
  (await db.query<{ actor: string; summary: string; entity_id: string }>('select actor, summary, entity_id from lp.events where kind = $1 order by id', [kind])).rows

describe('rename an agent', () => {
  it('trims, saves and logs one activity row; same name is a no-op', async () => {
    expect(await renameAgent(db, 'owner', 'tab', '  Tab   Two ')).toEqual({ changed: true })
    expect((await actorDetail(db, 'tab'))!.actor.display_name).toBe('Tab Two')
    expect(await renameAgent(db, 'owner', 'tab', 'Tab Two')).toEqual({ changed: false })
    const ev = await events('agent.renamed')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actor: 'owner', entity_id: 'tab' })
    expect(ev[0].summary).toContain('to Tab Two')
  })
  it('refuses empty or over-80 names, people, system, owner and non-owners', async () => {
    await expect(renameAgent(db, 'owner', 'tab', '   ')).rejects.toThrow(/name/)
    await expect(renameAgent(db, 'owner', 'tab', 'x'.repeat(81))).rejects.toThrow(/80/)
    await expect(renameAgent(db, 'owner', 'owner', 'X')).rejects.toThrow(/built in/)
    await expect(renameAgent(db, 'owner', 'system', 'X')).rejects.toThrow(/built in/)
    await expect(renameAgent(db, 'tab', 'hermes', 'X')).rejects.toThrow(/Only an owner/)
    await expect(renameAgent(db, 'owner', 'nobody', 'X')).rejects.toThrow(/No actor/)
  })
})

describe('disable / re-enable an agent', () => {
  it('a disabled agent drops out of listActors, shows in Disabled agents, and its keys stop working', async () => {
    const { key } = await mintAgentKey(db, 'owner', 'tab')
    expect(await agentForDbKey(db, `Bearer ${key}`)).toBe('tab')

    expect(await setAgentActive(db, 'owner', 'tab', false)).toEqual({ changed: true })
    expect((await listActors(db)).map((a) => a.id)).not.toContain('tab')
    expect((await listDisabledAgents(db)).map((a) => a.id)).toEqual(['tab'])
    expect(await agentForDbKey(db, `Bearer ${key}`)).toBeNull()
    expect(await getActor(db, 'tab')).toBeNull()
    expect((await actorDetail(db, 'tab'))!.actor.active).toBe(false)

    expect(await setAgentActive(db, 'owner', 'tab', false)).toEqual({ changed: false })
    expect(await setAgentActive(db, 'owner', 'tab', true)).toEqual({ changed: true })
    expect(await agentForDbKey(db, `Bearer ${key}`)).toBe('tab')
    expect(await listDisabledAgents(db)).toEqual([])
    expect((await events('agent.disabled'))).toHaveLength(1)
    expect((await events('agent.enabled'))).toHaveLength(1)
  })
  it('never disables system or owner, and an agent cannot disable another', async () => {
    await expect(setAgentActive(db, 'owner', 'system', false)).rejects.toThrow(/built in/)
    await expect(setAgentActive(db, 'owner', 'owner', false)).rejects.toThrow(/built in/)
    await expect(setAgentActive(db, 'hermes', 'tab', false)).rejects.toThrow(/Only an owner/)
  })
})

describe('can_send', () => {
  it('toggles the flag, logs it, and listActors reports it', async () => {
    const before = (await listActors(db)).find((a) => a.id === 'tab')!.can_send
    expect(await setAgentCanSend(db, 'owner', 'tab', !before)).toEqual({ changed: true })
    expect((await listActors(db)).find((a) => a.id === 'tab')!.can_send).toBe(!before)
    expect(await setAgentCanSend(db, 'owner', 'tab', !before)).toEqual({ changed: false })
    expect(await events('agent.can_send')).toHaveLength(1)
  })
})
