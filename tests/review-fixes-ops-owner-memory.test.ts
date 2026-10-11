import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { runOp } from '@/lib/ops/dispatch'
import { requiredRole } from '@/lib/ops/actor-role'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

// Viktor's re-check of #88 at 755a5d0 (four non-blocking items):
//  1. a second human Owner still got 403 on integrations, jobs and the Instantly reconcile
//     (literal actor !== 'owner' checks);
//  2. a Viewer's key could read feed/inbox but not feed_ack/mark_read, so items came back every 2 min;
//  3. memory_get accepted any scope, so any key could read another agent's private memory.
describe("review fix: second Owner on integrations/jobs/reconcile, Viewer acks, memory_get scope", () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    await db.query(`insert into lp.actors (id, kind, display_name, active, role, email) values
      ('vera', 'human', 'Vera', true, 'viewer', 'vera@example.com'),
      ('ed', 'human', 'Ed', true, 'editor', 'ed@example.com'),
      ('olga', 'human', 'Olga', true, 'owner', 'olga@example.com')
      on conflict do nothing`)
    await db.query(`insert into lp.actors (id, kind, display_name) values
      ('hermes', 'agent', 'Hermes'), ('instinct', 'agent', 'Instinct') on conflict do nothing`)
  })
  afterAll(async () => { await db.close() })

  const status = async (actor: string, op: string, args: Record<string, unknown>) => {
    try {
      await runOp(db, actor, op, args)
      return 200
    } catch (e) {
      return (e as { status?: number }).status ?? 500
    }
  }

  it('a second human Owner can add tools, report tool health and manage jobs; an agent still cannot', async () => {
    expect(await status('olga', 'put_integration', { id: 'olga-tool', name: 'Olga Tool', kind: 'link' })).toBe(200)
    expect(await status('olga', 'report_integration_health', { id: 'olga-tool', status: 'ok' })).toBe(200)
    expect(await status('olga', 'put_job', { name: 'olga_job', kind: 'instantly_reconcile', enabled: false })).toBe(200)
    expect(await status('olga', 'set_job_enabled', { name: 'olga_job', enabled: false })).toBe(200)

    expect(await status('hermes', 'put_integration', { id: 'h-tool', name: 'H', kind: 'link' })).toBe(403)
    expect(await status('hermes', 'report_integration_health', { id: 'olga-tool', status: 'down' })).toBe(403)
    expect(await status('hermes', 'put_job', { name: 'h_job', kind: 'instantly_reconcile' })).toBe(403)
    expect(await status('hermes', 'instantly_reconcile_run', {})).toBe(403)
    // the runner keeps its access
    expect(await status('system', 'report_integration_health', { id: 'olga-tool', status: 'ok' })).toBe(200)
  })

  it('the Instantly reconcile no longer refuses a second Owner on role (it gets past the owner check)', async () => {
    expect(await status('olga', 'instantly_reconcile_run', {})).not.toBe(403)
  })

  it("a Viewer's key can ack its own feed and mark its own inbox read", async () => {
    expect(requiredRole('feed_ack')).toBe('viewer')
    expect(requiredRole('mark_read')).toBe('viewer')
    expect(await status('vera', 'feed', {})).toBe(200)
    expect(await status('vera', 'feed_ack', { ids: [] })).toBe(200)
    expect(await status('vera', 'mark_read', {})).toBe(200)
  })

  it("memory_get: own scope and 'shared' only; another actor's private notes need an Owner", async () => {
    await runOp(db, 'hermes', 'memory_put', { key: 'private-k', notes: 'hermes only' })
    await runOp(db, 'hermes', 'memory_put', { key: 'team-k', notes: 'for everyone', scope: 'shared' })

    expect(await status('hermes', 'memory_get', { key: 'private-k' })).toBe(200)
    expect(await status('instinct', 'memory_get', { key: 'private-k', scope: 'hermes' })).toBe(403)
    expect(await status('vera', 'memory_get', { key: 'private-k', scope: 'hermes' })).toBe(403)
    expect(await status('ed', 'memory_get', { key: 'private-k', scope: 'hermes' })).toBe(403)
    expect(await status('vera', 'memory_get', { key: 'team-k', scope: 'shared' })).toBe(200)

    const o = (await runOp(db, 'olga', 'memory_get', { key: 'private-k', scope: 'hermes' })) as { notes: string }
    expect(o.notes).toBe('hermes only')
    const own = (await runOp(db, 'owner', 'memory_get', { key: 'private-k', scope: 'hermes' })) as { notes: string }
    expect(own.notes).toBe('hermes only')
  })
})
