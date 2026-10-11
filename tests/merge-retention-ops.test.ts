import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

describe('merge + retention ops (via dispatch)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it('merge_candidates is readable by an agent; merge is owner only', async () => {
    const a = await addCompany(db, { name: 'Agent Co', domain: 'agentco.example' })
    const b = await addCompany(db, { name: 'Agent Co 2' })
    await db.query(`update lp.companies set website = 'https://AgentCo.example' where id = $1`, [b])
    const cands = (await runOp(db, 'tab', 'merge_candidates', { entity: 'company' })) as unknown[]
    expect(Array.isArray(cands)).toBe(true)

    const err = await runOp(db, 'tab', 'merge', { entity: 'company', keep: a, merge: b }).catch((e) => e)
    expect(err).toBeInstanceOf(OpsError)
    expect((err as InstanceType<typeof OpsError>).status).toBe(403)

    const result = (await runOp(db, 'owner', 'merge', { entity: 'company', keep: a, merge: b })) as { kept_id: number }
    expect(result.kept_id).toBe(a)
  })

  it('retention ops: list is open, set_retention_policy and forget_contact are owner only', async () => {
    const list = (await runOp(db, 'tab', 'list_retention_policies', {})) as { event_category: string }[]
    expect(list.length).toBeGreaterThan(0)

    const denied = await runOp(db, 'tab', 'set_retention_policy', { event_category: 'email_opened', keep_days: 100 }).catch((e) => e)
    expect(denied).toBeInstanceOf(OpsError)
    expect((denied as InstanceType<typeof OpsError>).status).toBe(403)

    const ok = (await runOp(db, 'owner', 'set_retention_policy', { event_category: 'email_opened', keep_days: 100 })) as { keep_days: number }
    expect(ok.keep_days).toBe(100)

    const co = await addCompany(db, { name: 'Ops Forget Co' })
    const { rows } = await db.query<{ id: number }>(
      `insert into lp.contacts (company_id, email, email_norm) values ($1, 'ops-forget@example.com', 'ops-forget@example.com') returning id`,
      [co],
    )
    const ct = rows[0].id
    const deniedForget = await runOp(db, 'tab', 'forget_contact', { contact_id: ct, confirm: 'ops-forget@example.com' }).catch((e) => e)
    expect(deniedForget).toBeInstanceOf(OpsError)

    const forgot = (await runOp(db, 'owner', 'forget_contact', { contact_id: ct, confirm: 'ops-forget@example.com' })) as { ok: boolean }
    expect(forgot.ok).toBe(true)
  })

  it('retention_sweep: only the owner, and only after confirming (Yaakov, Oct 11: the owner chooses every run)', async () => {
    const denied = await runOp(db, 'tab', 'retention_sweep', { confirm: true }).catch((e) => e)
    expect(denied).toBeInstanceOf(OpsError)
    const system = await runOp(db, 'system', 'retention_sweep', { confirm: true }).catch((e) => e)
    expect(system).toBeInstanceOf(OpsError)
    const unconfirmed = await runOp(db, 'owner', 'retention_sweep', {}).catch((e) => e)
    expect((unconfirmed as OpsError).status).toBe(409)
    const ok = (await runOp(db, 'owner', 'retention_sweep', { confirm: true })) as { total_deleted: number }
    expect(typeof ok.total_deleted).toBe('number')
  })
})
