import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

describe('suppression ops (lib/suppressions/ops.ts, via dispatch)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it('suppress / list_suppressions / unsuppress round-trip as an agent', async () => {
    const row = await runOp(db, 'tab', 'suppress', { email: 'agent-added@x.com', reason: 'manual' }) as { id: number }
    expect(row.id).toBeGreaterThan(0)
    const list = await runOp(db, 'tab', 'list_suppressions', { q: 'agent-added' }) as { rows: { id: number }[]; total: number }
    expect(list.rows.some((r) => r.id === row.id)).toBe(true)
    const lifted = await runOp(db, 'tab', 'unsuppress', { id: row.id }) as { lifted_at: string | null }
    expect(lifted.lifted_at).not.toBeNull()
  })

  it('is_suppressed answers one email or a batch', async () => {
    await runOp(db, 'tab', 'suppress', { email: 'single@x.com', reason: 'bounced' })
    const single = await runOp(db, 'tab', 'is_suppressed', { email: 'single@x.com' }) as { suppressed: boolean }
    expect(single.suppressed).toBe(true)
    const batch = await runOp(db, 'tab', 'is_suppressed', { emails: ['single@x.com', 'clean@x.com'] }) as Record<string, { suppressed: boolean }>
    expect(batch['single@x.com'].suppressed).toBe(true)
    expect(batch['clean@x.com'].suppressed).toBe(false)
  })

  it('a bad reason comes back as a 400 OpsError, not a raw exception', async () => {
    const err = await runOp(db, 'tab', 'suppress', { email: 'x@y.com', reason: 'nonsense' }).catch((e) => e)
    expect(err).toBeInstanceOf(OpsError)
    expect((err as InstanceType<typeof OpsError>).status).toBe(400)
  })

  it('export/import CSV ops round-trip', async () => {
    const imp = await runOp(db, 'tab', 'import_suppressions_csv', { csv: 'email,reason\nops-csv@x.com,manual\n' }) as { added: number }
    expect(imp.added).toBe(1)
    const exp = await runOp(db, 'tab', 'export_suppressions_csv', { q: 'ops-csv' }) as { csv: string }
    expect(exp.csv).toContain('ops-csv@x.com')
  })

  it('unknown op is not this one', async () => {
    await expect(runOp(db, 'tab', 'not_a_real_op', {})).rejects.toThrow(/unknown op/)
  })
})
