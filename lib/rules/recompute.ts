/**
 * Keeping stored verdicts (lp.lead_evaluations) current, without ever blocking
 * a page:
 *
 *  - A save queues a full re-score of that rule set (lp.rule_recompute). It runs
 *    in batches of companies by id, each batch its own short transaction, and
 *    resumes from its cursor if it is cut off. A second save mid-run restarts it
 *    at the new version.
 *  - A change to a lead marks its verdicts stale (database trigger, 0010); a
 *    pass re-scores stale rows and scores leads that have none yet.
 *  - Passes run in the background after a save, when the Overview or Rules page
 *    is opened, and when an agent calls the rules_recompute op. Each pass has a
 *    time budget and stops cleanly; the next pass carries on.
 *
 * Pages that need a single answer now (the lead page, Add to Instantly) do not
 * wait for any of this: they call evaluateLead directly.
 */
import type { Db, Queryable } from '../db/types.ts'
import { evaluateLead, type LeadVerdict, type RuleSetLike } from './evaluate.ts'
import { loadLeadFacts } from './load.ts'

export const BATCH = 500

interface RsRow extends RuleSetLike {
  scope: string
  segment: string | null
  campaign_id: string | null
}

export async function queueRecompute(q: Queryable, ruleSetId: number, version: number, actor: string | null): Promise<void> {
  await q.query(
    `insert into lp.rule_recompute (rule_set_id, version, status, cursor, processed, total, requested_by, requested_at, heartbeat_at, finished_at, error)
     values ($1, $2, 'queued', 0, 0, null, $3, now(), null, null, null)
     on conflict (rule_set_id) do update set version = excluded.version, status = 'queued', cursor = 0, processed = 0, total = null,
       requested_by = excluded.requested_by, requested_at = now(), heartbeat_at = null, finished_at = null, error = null`,
    [ruleSetId, version, actor],
  )
}

/** Which companies a rule set scores. Templates score nothing. */
function scopeSql(rs: RsRow, alias = 'c', p = 2): { sql: string; params: unknown[] } {
  if (rs.scope === 'pool') return { sql: `${alias}.segment = $${p}`, params: [rs.segment] }
  if (rs.scope === 'campaign') {
    return {
      sql: `($${p}::text is null or ${alias}.segment = $${p})`,
      params: [rs.segment],
    }
  }
  if (rs.scope === 'default') return { sql: 'true', params: [] }
  return { sql: 'false', params: [] }
}

async function loadRs(q: Queryable, id: number): Promise<RsRow | null> {
  const { rows } = await q.query<RsRow>(
    `select r.id, r.version, r.requirements, r.fields, r.scope,
            coalesce(r.segment, case when r.scope = 'campaign' then (select m.segment from lp.campaign_meta m where m.campaign_id = r.campaign_id) end) as segment,
            r.campaign_id
       from lp.rule_sets r where r.id = $1 and not r.archived`,
    [id],
  )
  return rows[0] ? { ...rows[0], id: Number(rows[0].id), version: Number(rows[0].version) } : null
}

export async function storeVerdicts(q: Queryable, rs: RuleSetLike, verdicts: LeadVerdict[]): Promise<void> {
  if (!verdicts.length) return
  const data = verdicts.map((v) => ({ company_id: v.company_id, contact_id: v.contact_id, tier: v.tier, batch: v.batch, reasons: v.reasons, merge: v.merge, missing: v.missing }))
  await q.query(
    `insert into lp.lead_evaluations (rule_set_id, company_id, contact_id, tier, batch, reasons, merge, missing, version, stale, evaluated_at)
     select $1, x.company_id, x.contact_id, x.tier, x.batch, x.reasons, x.merge, x.missing, $2, false, now()
       from jsonb_to_recordset($3::jsonb) as x(company_id bigint, contact_id bigint, tier text, batch text, reasons jsonb, merge jsonb, missing jsonb)
     on conflict (rule_set_id, company_id) do update set contact_id = excluded.contact_id, tier = excluded.tier, batch = excluded.batch, reasons = excluded.reasons,
       merge = excluded.merge, missing = excluded.missing, version = excluded.version, stale = false, evaluated_at = excluded.evaluated_at`,
    [rs.id, rs.version, JSON.stringify(data)],
  )
}

/** Score these companies under a rule set (no write). */
export async function evaluateCompanies(q: Queryable, rs: RuleSetLike, companyIds: number[], now = new Date()): Promise<LeadVerdict[]> {
  const facts = await loadLeadFacts(q, companyIds)
  return [...facts.values()].map((lead) => evaluateLead(lead, rs, now))
}

/** One batch of a queued full re-score. Returns false when there was nothing to do. */
export async function recomputeBatch(db: Db, ruleSetId: number, batch = BATCH): Promise<{ worked: boolean; done: boolean; processed: number }> {
  return db.tx(async (q) => {
    const job = await q.query<{ version: number; cursor: number; status: string; processed: number; total: number | null }>(
      `select version, cursor, status, processed, total from lp.rule_recompute where rule_set_id = $1 and status in ('queued', 'running') for update skip locked`,
      [ruleSetId],
    )
    const j = job.rows[0]
    if (!j) return { worked: false, done: false, processed: 0 }
    const rs = await loadRs(q, ruleSetId)
    if (!rs) {
      await q.query('delete from lp.rule_recompute where rule_set_id = $1', [ruleSetId])
      return { worked: false, done: true, processed: 0 }
    }
    const scope = scopeSql(rs, 'c', 3)
    let total = j.total
    if (total == null) {
      const t = await q.query<{ n: number }>(`select count(*)::int as n from lp.companies c where ${scopeSql(rs, 'c', 1).sql}`, scopeSql(rs, 'c', 1).params)
      total = Number(t.rows[0].n)
    }
    const ids = await q.query<{ id: number }>(
      `select c.id from lp.companies c where c.id > $1 and ${scope.sql} order by c.id limit $2`,
      [Number(j.cursor), batch, ...scope.params],
    )
    const list = ids.rows.map((r) => Number(r.id))
    const verdicts = await evaluateCompanies(q, rs, list)
    await storeVerdicts(q, rs, verdicts)
    const processed = Number(j.processed) + list.length
    const done = list.length < batch
    if (done) {
      // Rows not re-scored in this pass belong to leads that left the scope.
      await q.query('delete from lp.lead_evaluations where rule_set_id = $1 and version < $2', [ruleSetId, rs.version])
      await q.query(
        `update lp.rule_recompute set status = 'done', processed = $2, total = $3, cursor = $4, heartbeat_at = now(), finished_at = now() where rule_set_id = $1`,
        [ruleSetId, processed, total, list.length ? list[list.length - 1] : Number(j.cursor)],
      )
    } else {
      await q.query(
        `update lp.rule_recompute set status = 'running', processed = $2, total = $3, cursor = $4, heartbeat_at = now() where rule_set_id = $1`,
        [ruleSetId, processed, total, list[list.length - 1]],
      )
    }
    return { worked: true, done, processed: list.length }
  })
}

/** Re-score stale verdicts and score in-scope leads that have none yet, for one rule set. */
export async function refreshRuleSet(db: Db, ruleSetId: number, limit = BATCH): Promise<number> {
  return db.tx(async (q) => {
    const rs = await loadRs(q, ruleSetId)
    if (!rs || rs.scope === 'template') return 0
    const scope = scopeSql(rs, 'c', 3)
    const { rows } = await q.query<{ id: number; in_scope: boolean }>(
      `(select e.company_id as id, exists (select 1 from lp.companies c where c.id = e.company_id and ${scope.sql}) as in_scope
          from lp.lead_evaluations e where e.rule_set_id = $1 and e.stale limit $2)
       union all
       (select c.id, true from lp.companies c
         where ${scope.sql} and not exists (select 1 from lp.lead_evaluations e where e.rule_set_id = $1 and e.company_id = c.id)
         order by c.id limit $2)`,
      [ruleSetId, limit, ...scope.params],
    )
    if (!rows.length) return 0
    const gone = rows.filter((r) => !r.in_scope).map((r) => Number(r.id))
    if (gone.length) await q.query('delete from lp.lead_evaluations where rule_set_id = $1 and company_id = any($2::bigint[])', [ruleSetId, gone])
    const keep = [...new Set(rows.filter((r) => r.in_scope).map((r) => Number(r.id)))]
    await storeVerdicts(q, rs, await evaluateCompanies(q, rs, keep))
    return rows.length
  })
}

/**
 * One background pass: queued re-scores first, then stale / unscored leads, until
 * the budget runs out. Safe to run from several places at once (row locks).
 */
export async function runRecompute(db: Db, opts: { budgetMs?: number; batch?: number } = {}): Promise<{ batches: number; leads: number; more: boolean }> {
  const budget = opts.budgetMs ?? 20_000
  const started = Date.now()
  const out = { batches: 0, leads: 0, more: false }
  const timeLeft = () => Date.now() - started < budget
  const jobs = await db.query<{ rule_set_id: number }>(
    `select rule_set_id from lp.rule_recompute where status in ('queued', 'running') order by requested_at`,
  )
  for (const j of jobs.rows) {
    while (timeLeft()) {
      const r = await recomputeBatch(db, Number(j.rule_set_id), opts.batch)
      if (!r.worked) break
      out.batches++
      out.leads += r.processed
      if (r.done) break
    }
    if (!timeLeft()) {
      out.more = true
      return out
    }
  }
  const sets = await db.query<{ id: number }>(`select id from lp.rule_sets where not archived and scope <> 'template' order by id`)
  for (const s of sets.rows) {
    while (timeLeft()) {
      const n = await refreshRuleSet(db, Number(s.id), opts.batch)
      if (!n) break
      out.batches++
      out.leads += n
    }
    if (!timeLeft()) {
      out.more = true
      return out
    }
  }
  return out
}

export interface RecomputeStatus {
  rule_set_id: number
  status: string
  version: number
  processed: number
  total: number | null
  requested_at: Date
  finished_at: Date | null
  error: string | null
}

export async function recomputeStatus(q: Queryable): Promise<Map<number, RecomputeStatus>> {
  const { rows } = await q.query<RecomputeStatus>(
    'select rule_set_id, status, version, processed, total, requested_at, finished_at, error from lp.rule_recompute',
  )
  return new Map(rows.map((r) => [Number(r.rule_set_id), { ...r, rule_set_id: Number(r.rule_set_id), version: Number(r.version), processed: Number(r.processed) }]))
}

export interface TierCounts {
  ready_personalized: number
  ready_generic: number
  parked: number
  stale: number
  scored: number
}

/** Stored verdict counts per rule set. */
export async function tierCounts(q: Queryable): Promise<Map<number, TierCounts>> {
  const { rows } = await q.query<{ rule_set_id: number; tier: string; n: number; stale: number }>(
    `select rule_set_id, tier, count(*)::int as n, count(*) filter (where stale)::int as stale from lp.lead_evaluations group by rule_set_id, tier`,
  )
  const out = new Map<number, TierCounts>()
  for (const r of rows) {
    const id = Number(r.rule_set_id)
    const c = out.get(id) ?? { ready_personalized: 0, ready_generic: 0, parked: 0, stale: 0, scored: 0 }
    if (r.tier === 'ready_personalized' || r.tier === 'ready_generic' || r.tier === 'parked') c[r.tier] += Number(r.n)
    c.stale += Number(r.stale)
    c.scored += Number(r.n)
    out.set(id, c)
  }
  return out
}

/** The most common park reasons for a rule set (stored verdicts). */
export async function topParkReasons(q: Queryable, ruleSetId: number | null, limit = 8): Promise<{ rule: string; label: string; n: number }[]> {
  const { rows } = await q.query<{ rule: string; label: string; n: number }>(
    `select r->>'rule' as rule, min(r->>'label') as label, count(*)::int as n
       from lp.lead_evaluations e
       join lp.rule_sets s on s.id = e.rule_set_id
       cross join lateral jsonb_array_elements(e.reasons) r
      where e.tier = 'parked' and (case when $1::bigint is null then s.scope = 'pool' else e.rule_set_id = $1 end)
      group by r->>'rule' order by n desc, rule limit $2`,
    [ruleSetId, limit],
  )
  return rows.map((r) => ({ ...r, n: Number(r.n) }))
}
