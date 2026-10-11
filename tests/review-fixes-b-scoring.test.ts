import { describe, it, expect, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { emitLeadEvent } from '@/lib/events/emit'
import { recomputeScores, upsertScoreModel, leadScores, listScoreModels } from '@/lib/scoring/engine'
import { runOp } from '@/lib/ops/dispatch'

// Review fixes (#74, Viktor): recompute-all ran every lead in one transaction (timed out
// ~50k leads); never-scored leads showed 0; removed rules kept adding points; a contact_id
// against a company model wrote a junk row; the nightly job had no runner handler.
describe('scoring review fixes (#74)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  afterAll(async () => db?.close())

  it('batches, drops removed rules, says "not scored", and queues through the runner', async () => {
    db = await createTestDb()
    const a = await addCompany(db, { name: 'Replied And Opened' })
    const b = await addCompany(db, { name: 'Opened Only' })
    const c = await addCompany(db, { name: 'Replied Only' })
    const never = await addCompany(db, { name: 'Never Scored' })
    await db.tx(async (q) => {
      await emitLeadEvent(q, { type: 'reply_received', company_id: a, source: 'test' })
      await emitLeadEvent(q, { type: 'email_opened', company_id: a, source: 'test' })
      await emitLeadEvent(q, { type: 'email_opened', company_id: b, source: 'test' })
      await emitLeadEvent(q, { type: 'reply_received', company_id: c, source: 'test' })
    })
    const eng = (await listScoreModels(db, { active_only: true })).find((m) => m.kind === 'engagement' && m.campaign_id == null)!
    const score = async (id: number) => (await leadScores(db, id)).find((s) => s.model.id === eng.id)?.score

    // Batch size 1: every lead commits in its own transaction; same answers as one batch.
    const res = await recomputeScores(db, 'system', { model_id: eng.id, batch_size: 1 })
    expect(res.map((r) => r.company_id).sort()).toEqual([a, b, c].sort())
    expect(await score(a)).toBe(12)
    expect(await score(b)).toBe(2)
    expect(await score(c)).toBe(10)

    // Never scored -> null ("Not scored"), not a made-up 0.
    expect(await score(never)).toBeNull()

    // Remove the "opened" rule: existing points from it must stop counting after a recompute,
    // including for a lead whose ONLY points came from that rule.
    await upsertScoreModel(db, 'owner', {
      id: eng.id, name: eng.name, entity: eng.entity, kind: eng.kind, campaign_id: eng.campaign_id,
      rules: eng.rules.filter((r) => r.event_type !== 'email_opened'), thresholds: eng.thresholds, max_points: eng.max_points,
    })
    await recomputeScores(db, 'system', {})
    expect(await score(a)).toBe(10)
    expect(await score(b)).toBe(0)
    expect(await score(c)).toBe(10)

    // A contact_id against company models: skipped, no junk row, no 23505 on a second call.
    const { rows: ct } = await db.query<{ id: number }>(`insert into lp.contacts (company_id, email, email_norm) values ($1, 'x@y.test', 'x@y.test') returning id`, [a])
    await recomputeScores(db, 'system', { contact_id: Number(ct[0].id) })
    await recomputeScores(db, 'system', { contact_id: Number(ct[0].id) })
    const { rows: junk } = await db.query(`select 1 from lp.scores s join lp.score_models m on m.id = s.model_id where m.entity = 'company' and s.contact_id is not null`)
    expect(junk).toHaveLength(0)

    // The nightly job now runs through the runner's ops_call handler, with a summary result.
    const { rows: job } = await db.query<{ kind: string; payload: { op: string; args: Record<string, unknown> } }>(`select kind, payload from lp.jobs where name = 'score_refresh'`)
    expect(job[0].kind).toBe('ops_call')
    expect(job[0].payload.op).toBe('recompute_scores')
    const summary = (await runOp(db, 'system', job[0].payload.op, job[0].payload.args)) as { leads_scored: number }
    expect(summary.leads_scored).toBeGreaterThanOrEqual(3)
  })
})
