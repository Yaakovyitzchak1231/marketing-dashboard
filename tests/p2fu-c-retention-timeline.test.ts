import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addTouch } from './helpers/lead-fixtures'
import { runOp } from '@/lib/ops/dispatch'
import { retentionPreview, retentionSweep, RetentionError, setRetentionPolicy } from '@/lib/retention/store'
import type { Db } from '@/lib/db/types'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

// Instinct #86 finding 4: deleting timeline history (lp.lead_events) changes scores, traits,
// segments etc. The owner sees which ones before choosing, the delete is batched, and a
// recompute is queued afterwards (never run inline, never automatic).
describe('p2fu-c: retention sweep preview, batching and recompute (finding 4)', () => {
  let db: TestDb
  let co: number
  const old = new Date(Date.now() - 400 * 86400_000).toISOString()
  const recent = new Date(Date.now() - 5 * 86400_000).toISOString()
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: number }>(sql, params)).rows[0].n)
  const score = async () => Number((await db.query<{ score: number }>(`select score from lp.scores where company_id = $1`, [co])).rows[0]?.score ?? -1)

  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Batch Sweep Co' })
    await setRetentionPolicy(db, 'owner', { event_category: 'email_opened', keep_days: 90 })
    for (let i = 0; i < 3; i++) await addTouch(db, { companyId: co, event: 'email_opened', at: old })
    await addTouch(db, { companyId: co, event: 'email_opened', at: recent })
    for (let i = 0; i < 5; i++) {
      await db.query(`insert into lp.lead_events (occurred_at, type, company_id, source, dedupe_key) values ($1, 'email_opened', $2, 'manual', $3)`, [old, co, `old-${i}`])
    }
    await db.query(`insert into lp.lead_events (occurred_at, type, company_id, source, dedupe_key) values ($1, 'email_opened', $2, 'manual', 'new-1')`, [recent, co])
    // an event type with no retention window: never touched
    await db.query(`insert into lp.lead_events (occurred_at, type, company_id, source, dedupe_key) values ($1, 'reply_received', $2, 'manual', 'reply-old')`, [old, co])
    const { rows: models } = await db.query<{ id: number }>(`select id from lp.score_models where entity = 'company' and kind = 'engagement' and campaign_id is null`)
    await runOp(db, 'owner', 'upsert_score_model', {
      id: models[0]?.id, name: 'Engagement', entity: 'company', kind: 'engagement',
      rules: [{ rule_key: 'opened', label: 'Opened', event_type: 'email_opened', points: 5 }],
    })
    await runOp(db, 'owner', 'recompute_scores', {})
    // a segment with an event condition on email_opened, one on reply_received, one without events
    await db.query(
      `insert into lp.segments (name, entity, definition) values
         ('Openers', 'company', '{"entity":"company","include":[{"kind":"event","event_type":"email_opened","count_op":">=","count":1}],"exclude":[]}'::jsonb),
         ('Repliers', 'company', '{"entity":"company","include":[{"kind":"event","event_type":"reply_received","count_op":">=","count":1}],"exclude":[]}'::jsonb),
         ('Everyone', 'company', '{"entity":"company","include":[],"exclude":[]}'::jsonb)`,
    )
    await db.query(`update lp.traits set last_computed_at = now()`)
    await db.query(`update lp.jobs set next_run_at = now() + interval '1 day' where name in ('score_refresh', 'traits_refresh')`)
  })
  afterAll(async () => { await db.close() })

  it('the preview names the score models, traits and segments that read the event types to be deleted', async () => {
    const p = await retentionPreview(db)
    expect(p.categories.find((c) => c.event_category === 'email_opened')).toMatchObject({ touches: 3, timeline_events: 5 })
    const impact = p.timeline_impact!
    expect(impact).toBeTruthy()
    expect(impact.event_types).toEqual(['email_opened'])
    expect(impact.score_models.map((m) => m.name)).toContain('Engagement')
    expect(impact.traits.map((t) => t.key).sort()).toEqual(['days_since_last_touch', 'opens_14d'])
    expect(impact.segments.map((s) => s.name)).toEqual(['Openers'])
    expect(impact.note).toMatch(/traits, segment event conditions, lead milestones and engagement benchmarks/)
  })

  it('without the opt-in: timeline untouched, nothing queued', async () => {
    const events = await count(`select count(*)::int n from lp.lead_events where company_id = $1`, [co])
    const r = await retentionSweep(db, 'owner', { confirm: true, batch_size: 2 })
    expect(r.total_deleted).toBe(3) // 2 + 1 across two batches
    expect(r.total_timeline_deleted).toBe(0)
    expect(r.recompute_queued).toEqual([])
    expect(await count(`select count(*)::int n from lp.lead_events where company_id = $1`, [co])).toBe(events)
    expect(await count(`select count(*)::int n from lp.jobs where name in ('score_refresh','traits_refresh') and next_run_at <= now()`)).toBe(0)
  })

  it('with the opt-in: deletes in batches, keeps earned points, resets affected traits and queues the recompute jobs', async () => {
    const before = await score()
    expect(before).toBeGreaterThan(0)
    const r = await retentionSweep(db, 'owner', { confirm: true, include_timeline: true, batch_size: 2 })
    expect(r.total_timeline_deleted).toBe(5)
    expect(await count(`select count(*)::int n from lp.lead_events where company_id = $1 and type = 'email_opened'`, [co])).toBe(1)
    expect(await count(`select count(*)::int n from lp.lead_events where company_id = $1 and type = 'reply_received'`, [co])).toBe(1)
    expect(await score()).toBe(before)
    expect(r.recompute_queued).toEqual(['score_refresh', 'traits_refresh'])
    expect(await count(`select count(*)::int n from lp.jobs where name in ('score_refresh','traits_refresh') and next_run_at <= now()`)).toBe(2)
    const traits = (await db.query<{ key: string; last_computed_at: string | null }>(`select key, last_computed_at from lp.traits order by key`)).rows
    const reset = traits.filter((t) => t.last_computed_at == null).map((t) => t.key).sort()
    expect(reset).toEqual(['days_since_last_touch', 'opens_14d'])
    const audit = await db.query<{ note: string }>(`select note from lp.status_history where entity_key = 'retention_sweep' order by id desc limit 1`)
    expect(audit.rows[0].note).toMatch(/and 5 timeline row\(s\).*queued score_refresh, traits_refresh/)
    // nothing left past the window: the preview no longer reports an impact
    expect((await retentionPreview(db)).timeline_impact).toBeUndefined()
  })

  it('a failure partway records what already committed and says so honestly', async () => {
    for (let i = 0; i < 4; i++) {
      await db.query(`insert into lp.lead_events (occurred_at, type, company_id, source, dedupe_key) values ($1, 'email_opened', $2, 'manual', $3)`, [old, co, `old2-${i}`])
    }
    // The 2nd timeline batch for email_opened fails mid-sweep (its transaction rolls back).
    let openedTimelineBatches = 0
    const flaky: Db = {
      query: db.query,
      tx: (fn, actor) => db.tx((q) => fn({
        query: async (text: string, params?: unknown[]) => {
          if (/delete from lp\.lead_events/.test(text) && params?.[0] === 'email_opened' && ++openedTimelineBatches === 2) throw new Error('connection reset')
          return q.query(text, params)
        },
      } as typeof q), actor),
    }
    const err = await retentionSweep(flaky, 'owner', { confirm: true, include_timeline: true, batch_size: 2 }).catch((e) => e)
    expect(err).toBeInstanceOf(RetentionError)
    expect(err.message).toMatch(/stopped partway after deleting 0 event row\(s\) and 2 timeline row\(s\)/)
    const audit = await db.query<{ note: string }>(`select note from lp.status_history where entity_key = 'retention_sweep' order by id desc limit 1`)
    expect(audit.rows[0].note).toMatch(/STOPPED PARTWAY/)
    // a re-run finishes the job
    const r = await retentionSweep(db, 'owner', { confirm: true, include_timeline: true, batch_size: 2 })
    expect(r.total_timeline_deleted).toBe(2)
  })

  it('rejects a silly batch size before deleting anything', async () => {
    await expect(retentionSweep(db, 'owner', { confirm: true, batch_size: 0 })).rejects.toThrow(/batch_size/)
  })
})

// Instinct #86 finding 10: lp.maintenance / lp.merge are transaction-local and only set inside
// the functions that need them; a normal update of lead_events is still refused.
describe('p2fu-c: lp.maintenance stays inside its transaction (finding 10)', () => {
  let db: TestDb
  let co: number
  let evId: number
  const old = new Date(Date.now() - 400 * 86400_000).toISOString()
  const flag = async (name: string) => (await db.query<{ v: string | null }>(`select current_setting($1, true) as v`, [name])).rows[0].v

  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Flag Co' })
    const { rows } = await db.query<{ id: number }>(
      `insert into lp.lead_events (occurred_at, type, company_id, source, dedupe_key) values (now(), 'email_opened', $1, 'manual', 'keep-1') returning id`, [co])
    evId = Number(rows[0].id)
  })
  afterAll(async () => { await db.close() })

  it('a normal update of lead_events.type is refused (plain query and inside a transaction)', async () => {
    await expect(db.query(`update lp.lead_events set type = 'email_link_clicked' where id = $1`, [evId])).rejects.toThrow(/append-only/)
    await expect(db.tx(async (q) => { await q.query(`update lp.lead_events set type = 'email_link_clicked' where id = $1`, [evId]) }, 'owner')).rejects.toThrow(/append-only/)
    await expect(db.query(`delete from lp.lead_events where id = $1`, [evId])).rejects.toThrow(/append-only/)
  })

  it('even with lp.maintenance on, the event type stays pinned (only email_norm/props may change)', async () => {
    await expect(db.tx(async (q) => {
      await q.query(`select set_config('lp.maintenance', 'on', true)`)
      await q.query(`update lp.lead_events set type = 'email_link_clicked' where id = $1`, [evId])
    }, 'owner')).rejects.toThrow(/append-only/)
  })

  it('after a timeline retention sweep commits, the flag is gone and a follow-up update/delete is refused', async () => {
    await setRetentionPolicy(db, 'owner', { event_category: 'email_opened', keep_days: 90 })
    await db.query(`insert into lp.lead_events (occurred_at, type, company_id, source, dedupe_key) values ($1, 'email_opened', $2, 'manual', 'old-1')`, [old, co])
    const r = await retentionSweep(db, 'owner', { confirm: true, include_timeline: true })
    expect(r.total_timeline_deleted).toBe(1)
    expect(await flag('lp.maintenance')).not.toBe('on')
    expect(await flag('lp.merge')).not.toBe('on')
    await expect(db.query(`update lp.lead_events set type = 'email_link_clicked' where id = $1`, [evId])).rejects.toThrow(/append-only/)
    await expect(db.query(`delete from lp.lead_events where id = $1`, [evId])).rejects.toThrow(/append-only/)
    expect(Number((await db.query<{ n: number }>(`select count(*)::int n from lp.lead_events where id = $1 and type = 'email_opened'`, [evId])).rows[0].n)).toBe(1)
  })

  it('app code sets lp.maintenance / lp.merge only transaction-locally, and only in the functions that need them', async () => {
    const { readdirSync, readFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const lines: string[] = []
    for (const dir of ['lib', 'app', 'scripts', 'runner']) {
      if (!existsSync(dir)) continue
      for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
        const file = join(dir, rel)
        if (!/\.(ts|tsx|mjs|js|sql)$/.test(file)) continue
        readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
          const code = text.trim()
          if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return
          if (/lp\.(maintenance|merge)\b/.test(code) && /set_config|\bset\s+(local\s+|session\s+)?lp\./i.test(code)) lines.push(`${file.split('\\').join('/')}:${i + 1}:${text.trim()}`)
        })
      }
    }
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(l, l).toMatch(/set_config\('lp\.(maintenance|merge)', '(on|off)', true\)/)
      expect(l, l).toMatch(/^(lib\/retention\/store\.ts|lib\/merge\/merge\.ts):/)
    }
  })
})
