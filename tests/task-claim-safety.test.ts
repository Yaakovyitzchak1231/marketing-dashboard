import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { assertTaskClaim, claimTask, completeTask, createTask, failTask, handoffTask, heartbeatTask, taskScopedDb, updateTask } from '@/lib/ops/core'
import { pauseAgent, pauseAll, resumeAgent, resumeAll } from '@/lib/ops/pause'
import { runOp } from '@/lib/ops/dispatch'
import { workTaskDb } from '@/engine/worker'
import type { Db } from '@/lib/db/types'

let db: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.close() })
async function task() {
  const t = await createTask(db, 'owner', { title: 'Fenced work', assigned_to: 'tab' })
  return (await claimTask(db, 'tab', { task_id: t.id }))!
}

describe('claim fencing and direct-worker pauses', () => {
  it('an expired holder cannot renew, finish, fail or hand off', async () => {
    const t = await task()
    await db.query("update lp.tasks set lease_expires_at = now() - interval '1 second' where id = $1", [t.id])
    for (const op of [
      () => heartbeatTask(db, 'tab', t.id), () => completeTask(db, 'tab', t.id),
      () => failTask(db, 'tab', t.id, { error: 'stale' }), () => handoffTask(db, 'tab', t.id, { to: 'hermes', note: 'stale' }),
    ]) await expect(op()).rejects.toThrow(/lease expired/)
  })
  it('reclaim by the same actor fences the old attempt, including omitted tokens', async () => {
    const old = await task()
    await db.query("update lp.tasks set lease_expires_at = now() - interval '1 second' where id = $1", [old.id])
    const current = (await claimTask(db, 'tab', { task_id: old.id }))!
    expect(current.attempts).toBe(old.attempts + 1)
    await expect(completeTask(db, 'tab', old.id)).rejects.toThrow(/claim_attempt/)
    await expect(heartbeatTask(db, 'tab', old.id, { claim_attempt: old.attempts })).rejects.toThrow(/claim_attempt/)
    await expect(failTask(db, 'tab', old.id, { error: 'old', claim_attempt: old.attempts })).rejects.toThrow(/claim_attempt/)
    await expect(handoffTask(db, 'tab', old.id, { to: 'hermes', note: 'old', claim_attempt: old.attempts })).rejects.toThrow(/claim_attempt/)
    expect((await completeTask(db, 'tab', current.id, { claim_attempt: current.attempts })).status).toBe('done')
  })
  it('manual updates cannot bypass claim fencing for agents', async () => {
    const t = await task()
    await expect(updateTask(db, 'tab', t.id, { status: 'done' })).rejects.toThrow(/Only a person/)
  })
  it('individual and global pause block direct claims, heartbeats, completions and checkpoints', async () => {
    const t = await task()
    const scoped = taskScopedDb(db, 'tab', t.id, t.attempts)
    for (const global of [false, true]) {
      if (global) await pauseAll(db, 'owner'); else await pauseAgent(db, 'owner', 'tab')
      await expect(claimTask(db, 'tab')).rejects.toMatchObject({ status: 423 })
      await expect(heartbeatTask(db, 'tab', t.id)).rejects.toMatchObject({ status: 423 })
      await expect(completeTask(db, 'tab', t.id)).rejects.toMatchObject({ status: 423 })
      await expect(scoped.query("update lp.tasks set title = 'unsafe' where id = $1", [t.id])).rejects.toMatchObject({ status: 423 })
      expect(await workTaskDb(db, t, { agent: 'tab', search: null, log: () => {} })).toBe('cancelled')
      if (global) await resumeAll(db, 'owner'); else await resumeAgent(db, 'owner', 'tab')
    }
    expect((await heartbeatTask(db, 'tab', t.id)).title).toBe('Fenced work')
  })
  it('an old direct-worker database handle cannot write after reclaim', async () => {
    const t = await task()
    const scoped = taskScopedDb(db, 'tab', t.id, t.attempts)
    await db.query("update lp.tasks set lease_expires_at = now() - interval '1 second' where id = $1", [t.id])
    await claimTask(db, 'tab', { task_id: t.id })
    await expect(scoped.query("update lp.tasks set title = 'stale' where id = $1", [t.id])).rejects.toThrow(/claim_attempt/)
  })
})

describe('research completion transaction', () => {
  async function researchTask() {
    const c = await db.query<{ id: number }>("insert into lp.companies(name) values ('Atomic research') returning id")
    const t = await createTask(db, 'owner', { title: 'Atomic research', kind: 'research_company', company_id: c.rows[0].id, assigned_to: 'tab' })
    const claimed = (await claimTask(db, 'tab', { task_id: t.id }))!
    const research = { company_id: c.rows[0].id, runner: 'tab', pages_fetched: [], emails: [], people: [], phones: [], facts: [], summary: 'No evidence' }
    return { claimed, research }
  }
  it('expired research cannot create any sources or change company status', async () => {
    const { claimed, research } = await researchTask()
    await db.query("update lp.tasks set lease_expires_at = now() - interval '1 second' where id = $1", [claimed.id])
    await expect(runOp(db, 'tab', 'complete_task', { task_id: claimed.id, claim_attempt: claimed.attempts, result: { research } })).rejects.toThrow(/lease expired/)
    expect((await db.query('select id from lp.sources where company_id = $1', [research.company_id])).rows).toHaveLength(0)
  })
  it('research writes roll back if task completion fails afterwards', async () => {
    const { claimed, research } = await researchTask()
    const failing: Db = { query: db.query, tx: (fn, actor) => db.tx((q) => fn({ query: (text, params) => {
      if (text.includes("update lp.tasks set status = 'done'")) throw new Error('injected completion failure')
      return q.query(text, params)
    } }), actor) }
    await expect(runOp(failing, 'tab', 'complete_task', { task_id: claimed.id, result: { research } })).rejects.toThrow(/injected/)
    expect((await db.query('select id from lp.sources where company_id = $1', [research.company_id])).rows).toHaveLength(0)
    expect((await db.tx((q) => assertTaskClaim(q, 'tab', claimed.id, claimed.attempts))).status).toBe('claimed')
  })
})
