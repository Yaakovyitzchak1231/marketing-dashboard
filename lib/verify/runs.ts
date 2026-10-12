/**
 * Verification runs with a cost gate (lp.verification_runs):
 *
 *   preview  -> the FREE precheck runs now and the paid cost is estimated
 *   approved -> a human clicked "Approve and run" with a dollar ceiling
 *   running  -> step() processes the next chunk; the UI calls it until done
 *   done | cancelled | failed
 *
 * The ceiling is enforced before every contact: we reserve its worst-case
 * paid cost (MillionVerifier + a possible ZeroBounce) and do not start it if
 * that could cross max_cost_usd. Spend never exceeds the ceiling; a run can
 * pause a few cents early. Spend is our estimate from list prices, not the
 * vendor's bill.
 */
import type { Db, Queryable } from '@/lib/db/types'
import { logEvent } from '@/lib/ops/events'
import { emitLeadEvent } from '@/lib/events/emit'
import { createPrechecker, precheckMany, type DnsResolver, type PrecheckResult } from './precheck'
import { estimateCost, getPricing, usd4, type CostEstimate, type Pricing } from './pricing'
import { selectCandidates, cleanFilter, mvPending, type LeadFilter, DEFAULT_RECHECK_DAYS } from './select'
import { nextContactStatus, precheckStep, runWaterfall, worstCaseCost, type StepRecord, type WaterfallKeys, type WaterfallOutcome } from './waterfall'
import type { FetchLike } from './types'

export type RunStatus = 'preview' | 'approved' | 'running' | 'done' | 'cancelled' | 'failed'

export interface RunSummary {
  estimate?: CostEstimate
  options?: { force: boolean; recheck_days: number; filter: LeadFilter | null; ids_given: number | null }
  selection?: { requested: number; eligible: number; skipped: { no_email: number; do_not_contact: number; recently_verified: number } }
  precheck?: { checked: number; passed: number; invalid: number; dns_unknown: number; by_result: Record<string, number>; role: number; free_provider: number }
  keys_at_preview?: { millionverifier: boolean; zerobounce: boolean }
  warnings?: string[]
  /** Final verdicts written so far, by verification_status. */
  verdicts?: Record<string, number>
  checks?: { millionverifier: number; zerobounce: number; precheck_rejected: number }
  not_checked?: { mv_key_missing: number; zb_key_missing: number; provider_error: number; already_verified: number; missing: number }
  paused?: string | null
  halted?: string | null
}

export interface RunRow {
  id: number
  status: RunStatus
  requested_by: string | null
  approved_by: string | null
  contact_ids: number[]
  contact_count: number
  precheck_pass: number | null
  est_mv_checks: number | null
  est_zb_checks: number | null
  est_cost_usd: number | null
  max_cost_usd: number | null
  spent_usd: number
  processed: number
  summary: RunSummary | null
  created_at: string | Date
  approved_at: string | Date | null
  finished_at: string | Date | null
}

export class RunError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'RunError'
  }
}

export interface VerifyEnv {
  keys: WaterfallKeys
  pricing: Pricing
  fetch?: FetchLike
  resolver?: DnsResolver
}

/** Keys and prices from the environment. Keys never leave the server. */
export function verifyEnvFromProcess(env: Record<string, string | undefined> = process.env): VerifyEnv {
  return {
    keys: {
      millionverifier: env.MILLIONVERIFIER_API_KEY?.trim() || null,
      zerobounce: env.ZEROBOUNCE_API_KEY?.trim() || null,
    },
    pricing: getPricing(env),
  }
}

/** Settings-aware env: MillionVerifier/ZeroBounce keys resolve through the
 * settings store (DB first, env fallback) the same way lib/instantly/client.ts
 * and lib/notify/mail.ts do, so a key saved on /settings takes effect at once. */
export async function verifyEnvFromConfig(env: Record<string, string | undefined> = process.env): Promise<VerifyEnv> {
  const { resolveConfig } = await import('../settings/store.ts')
  const [{ value: mv }, { value: zb }] = await Promise.all([
    resolveConfig('millionverifier.api_key', env),
    resolveConfig('zerobounce.api_key', env),
  ])
  return {
    keys: { millionverifier: mv || null, zerobounce: zb || null },
    pricing: getPricing(env),
  }
}

const RUN_COLUMNS = `id, status, requested_by, approved_by, contact_ids, contact_count, precheck_pass, est_mv_checks,
  est_zb_checks, est_cost_usd, max_cost_usd, spent_usd, processed, summary, created_at, approved_at, finished_at`

function normalizeRun(r: RunRow): RunRow {
  const num = (v: unknown) => (v == null ? null : Number(v))
  return {
    ...r,
    contact_ids: (r.contact_ids ?? []).map(Number),
    est_cost_usd: num(r.est_cost_usd),
    max_cost_usd: num(r.max_cost_usd),
    spent_usd: Number(r.spent_usd ?? 0),
    summary: (typeof r.summary === 'string' ? JSON.parse(r.summary) : r.summary) as RunSummary | null,
  }
}

export async function getRun(q: Queryable, id: number): Promise<RunRow | null> {
  const { rows } = await q.query<RunRow>(`select ${RUN_COLUMNS} from lp.verification_runs where id = $1`, [id])
  return rows[0] ? normalizeRun(rows[0]) : null
}

export async function listRuns(q: Queryable, limit = 20): Promise<RunRow[]> {
  const { rows } = await q.query<RunRow>(
    `select ${RUN_COLUMNS} from lp.verification_runs order by id desc limit $1`,
    [Math.min(100, Math.max(1, limit))],
  )
  return rows.map(normalizeRun)
}

/** $0.74, $12.30; sub-cent amounts keep 4 decimals ($0.0039). */
export const money = (n: number) => `$${n === 0 || Math.abs(n) >= 0.01 ? n.toFixed(2) : n.toFixed(4)}`

function plural(n: number, one: string, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`
}

async function insertStep(q: Queryable, contactId: number, email: string, runId: number, s: StepRecord) {
  await q.query(
    `insert into lp.verification_results (contact_id, email, provider, result, verdict, sub_result, cost_usd, run_id, raw)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [contactId, email, s.provider, s.result, s.verdict, s.sub_result, s.cost_usd, runId, s.raw == null ? null : JSON.stringify(s.raw)],
  )
}

// ---------------------------------------------------------------------------
// preview

export interface PreviewInput {
  contact_ids?: number[] | null
  filter?: LeadFilter | null
  limit?: number | null
  force?: boolean
  recheck_days?: number
  actor?: string
}

export async function createPreview(db: Db, input: PreviewInput, env: VerifyEnv): Promise<RunRow> {
  const actor = input.actor ?? 'owner'
  const recheckDays = Math.max(0, Math.floor(input.recheck_days ?? DEFAULT_RECHECK_DAYS))
  const sel = await selectCandidates(db, {
    contact_ids: input.contact_ids,
    filter: input.filter,
    limit: input.limit,
    force: Boolean(input.force),
    recheck_days: recheckDays,
  })
  const checker = createPrechecker({ resolver: env.resolver })
  const pre = await precheckMany(sel.eligible.map((c) => c.email_norm as string), checker)

  const byResult: Record<string, number> = {}
  let passed = 0
  let invalid = 0
  let dnsUnknown = 0
  let role = 0
  let free = 0
  let zbDirect = 0
  for (let i = 0; i < pre.length; i++) {
    const p = pre[i]
    if (p.verdict !== 'invalid' && mvPending(sel.eligible[i])) zbDirect++
    byResult[p.result] = (byResult[p.result] ?? 0) + 1
    if (p.verdict === 'invalid') invalid++
    else passed++
    if (p.verdict === 'unknown') dnsUnknown++
    if (p.flags.role) role++
    if (p.flags.free_provider) free++
  }
  const estimate = estimateCost(passed, env.pricing, zbDirect)
  const warnings: string[] = []
  const mvOn = Boolean(env.keys.millionverifier)
  const zbOn = Boolean(env.keys.zerobounce)
  if (!mvOn) warnings.push('MillionVerifier key not set: those addresses stay unchecked.')
  if (!zbOn) warnings.push('ZeroBounce key not set: catch-all / unknown answers stay at MillionVerifier’s word.')
  // Only tiers whose key is set will actually run (and cost anything).
  const mvChecks = mvOn ? estimate.mv_checks : 0
  const zbChecks = zbOn ? (mvOn ? estimate.zb_checks : estimate.zb_direct) : 0
  const mvCost = usd4(mvChecks * env.pricing.mvCostPerCheck)
  const zbCost = usd4(zbChecks * env.pricing.zbCostPerCheck)
  const effectiveEstimate: CostEstimate =
    mvOn && zbOn
      ? estimate
      : {
          ...estimate,
          mv_checks: mvChecks,
          zb_checks: zbChecks,
          zb_direct: zbOn ? estimate.zb_direct : 0,
          mv_cost_usd: mvCost,
          zb_cost_usd: zbCost,
          total_usd: usd4(mvCost + zbCost),
          math:
            `Only tiers with a key run: ${mvChecks} MillionVerifier + ${zbChecks} ZeroBounce = $${usd4(mvCost + zbCost).toFixed(4)}. ` +
            `With both keys it would be: ${estimate.math}`,
        }

  const summary: RunSummary = {
    estimate: effectiveEstimate,
    options: {
      force: Boolean(input.force),
      recheck_days: recheckDays,
      filter: input.filter ? cleanFilter(input.filter) : null,
      ids_given: input.contact_ids?.length ? input.contact_ids.length : null,
    },
    selection: { requested: sel.requested, eligible: sel.eligible.length, skipped: sel.skipped },
    precheck: { checked: pre.length, passed, invalid, dns_unknown: dnsUnknown, by_result: byResult, role, free_provider: free },
    keys_at_preview: { millionverifier: Boolean(env.keys.millionverifier), zerobounce: Boolean(env.keys.zerobounce) },
    warnings,
  }

  return db.tx(async (t) => {
    const { rows } = await t.query<{ id: number }>(
      `insert into lp.verification_runs
         (status, requested_by, contact_ids, contact_count, precheck_pass, est_mv_checks, est_zb_checks, est_cost_usd, summary)
       values ('preview', $1, $2::bigint[], $3, $4, $5, $6, $7, $8) returning id`,
      [
        actor,
        sel.eligible.map((c) => c.id),
        sel.eligible.length,
        passed,
        effectiveEstimate.mv_checks,
        effectiveEstimate.zb_checks,
        effectiveEstimate.total_usd,
        JSON.stringify(summary),
      ],
    )
    const runId = rows[0].id
    for (let i = 0; i < sel.eligible.length; i++) {
      await insertStep(t, sel.eligible[i].id, pre[i].email, runId, precheckStep(pre[i]))
    }
    await logEvent(t, {
      actor,
      kind: 'verify.preview',
      summary:
        `Verification preview #${runId}: ${plural(pre.length, 'lead')} checked free, ${invalid} failed the free check, ` +
        `${effectiveEstimate.mv_checks} would go to MillionVerifier (≈${money(effectiveEstimate.mv_cost_usd)}), ` +
        `~${effectiveEstimate.zb_checks} to ZeroBounce (≈${money(effectiveEstimate.zb_cost_usd)}), total ≈${money(effectiveEstimate.total_usd)}`,
      entity_type: 'verification_run',
      entity_id: runId,
      data: { selection: summary.selection, precheck: summary.precheck, estimate: effectiveEstimate },
    })
    return (await getRun(t, runId)) as RunRow
  }, actor)
}

// ---------------------------------------------------------------------------
// approve / cancel

export async function approveRun(db: Db, id: number, maxCostUsd: number, actor = 'owner'): Promise<RunRow> {
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0 || maxCostUsd > 10_000) {
    throw new RunError(400, 'max_cost_usd must be a dollar amount between 0 and 10000')
  }
  const max = usd4(maxCostUsd)
  return db.tx(async (t) => {
    const { rows } = await t.query<RunRow>(`select ${RUN_COLUMNS} from lp.verification_runs where id = $1 for update`, [id])
    if (!rows[0]) throw new RunError(404, `No verification run #${id}`)
    const run = normalizeRun(rows[0])
    if (!['preview', 'approved', 'running'].includes(run.status)) {
      throw new RunError(409, `Run #${id} is ${run.status}; it can't be approved`)
    }
    if (max < run.spent_usd) {
      throw new RunError(400, `The ceiling can't be below what this run already spent (${money(run.spent_usd)})`)
    }
    const summary: RunSummary = { ...(run.summary ?? {}), paused: null }
    await t.query(
      `update lp.verification_runs
         set status = case when status = 'preview' then 'approved' else status end,
             approved_by = $2, approved_at = now(), max_cost_usd = $3, summary = $4
       where id = $1`,
      [id, actor, max, JSON.stringify(summary)],
    )
    await logEvent(t, {
      actor,
      kind: 'verify.approved',
      summary:
        run.status === 'preview'
          ? `Approved verification run #${id}: ${plural(run.contact_count, 'lead')}, estimate ≈${money(run.est_cost_usd ?? 0)}, ceiling ${money(max)}`
          : `Raised the ceiling on verification run #${id} to ${money(max)} (spent so far ${money(run.spent_usd)})`,
      entity_type: 'verification_run',
      entity_id: id,
      data: { max_cost_usd: max, est_cost_usd: run.est_cost_usd },
    })
    return (await getRun(t, id)) as RunRow
  }, actor)
}

export async function cancelRun(db: Db, id: number, actor = 'owner'): Promise<RunRow> {
  return db.tx(async (t) => {
    const run = await getRun(t, id)
    if (!run) throw new RunError(404, `No verification run #${id}`)
    if (!['preview', 'approved', 'running'].includes(run.status)) {
      throw new RunError(409, `Run #${id} is already ${run.status}`)
    }
    await t.query(`update lp.verification_runs set status = 'cancelled', finished_at = now() where id = $1`, [id])
    await logEvent(t, {
      actor,
      kind: 'verify.cancelled',
      summary: `Cancelled verification run #${id} after ${run.processed} of ${run.contact_count} (${money(run.spent_usd)} spent)`,
      entity_type: 'verification_run',
      entity_id: id,
    })
    return (await getRun(t, id)) as RunRow
  }, actor)
}

// ---------------------------------------------------------------------------
// step

export interface StepOptions {
  chunk?: number
  concurrency?: number
  /** Stop starting new contacts after this many ms (serverless functions are short). */
  timeBudgetMs?: number
  actor?: string
}

export interface StepReport {
  run: RunRow
  processed_now: number
  spent_now_usd: number
  done: boolean
  /** Why it stopped early, in plain words (cost ceiling, a provider refused the key, ...). */
  paused: string | null
  halted: string | null
}

const LOCK_SECONDS = 180

async function acquireStepLock(db: Db, id: number): Promise<boolean> {
  const { rows } = await db.query<{ resource: string }>(
    `insert into lp.locks (resource, holder, note, lease_expires_at)
     values ($1, 'system', 'verification step in progress', now() + make_interval(secs => $2))
     on conflict (resource) do update
       set holder = excluded.holder, note = excluded.note, acquired_at = now(), heartbeat_at = now(),
           lease_expires_at = excluded.lease_expires_at
       where lp.locks.lease_expires_at < now()
     returning resource`,
    [`verify-run:${id}`, LOCK_SECONDS],
  )
  return rows.length === 1
}

async function releaseStepLock(db: Db, id: number) {
  await db.query(`delete from lp.locks where resource = $1 and holder = 'system'`, [`verify-run:${id}`])
}

interface ContactNow {
  id: number
  email_norm: string | null
  status: string
  verification_status: string
  verified_at: string | Date | null
  verified_by: string | null
  company_id: number | null
}

type ContactResult =
  | { kind: 'done'; outcome: WaterfallOutcome | null; skip?: 'already_verified' | 'missing' }
  | { kind: 'not_started' }
  | { kind: 'account_error'; outcome: WaterfallOutcome }

function bump(rec: Record<string, number>, key: string, by = 1) {
  rec[key] = (rec[key] ?? 0) + by
}

export async function stepRun(db: Db, id: number, env: VerifyEnv, opts: StepOptions = {}): Promise<StepReport> {
  const chunk = Math.min(100, Math.max(1, Math.floor(opts.chunk ?? 20)))
  const concurrency = Math.min(8, Math.max(1, Math.floor(opts.concurrency ?? 4)))
  const timeBudgetMs = opts.timeBudgetMs ?? 40_000
  const started = Date.now()

  const run0 = await getRun(db, id)
  if (!run0) throw new RunError(404, `No verification run #${id}`)
  if (run0.status === 'preview') throw new RunError(409, `Run #${id} has not been approved yet`)
  if (!['approved', 'running'].includes(run0.status)) throw new RunError(409, `Run #${id} is ${run0.status}`)
  if (run0.max_cost_usd == null) throw new RunError(409, `Run #${id} has no approved ceiling`)
  if (!(await acquireStepLock(db, id))) throw new RunError(409, `Run #${id} is already being processed`)

  try {
    const run = (await getRun(db, id)) as RunRow // re-read under the lock
    if (!['approved', 'running'].includes(run.status)) throw new RunError(409, `Run #${id} is ${run.status}`)
    const actor = opts.actor ?? run.approved_by ?? 'owner'
    if (run.status === 'approved') {
      await db.query(`update lp.verification_runs set status = 'running' where id = $1 and status = 'approved'`, [id])
    }

    const max = run.max_cost_usd as number
    const ids = run.contact_ids.slice(run.processed, run.processed + chunk)
    const runCreated = new Date(run.created_at)

    // Current contact rows + the precheck recorded at preview.
    const { rows: contacts } = await db.query<ContactNow>(
      `select id, email_norm, status, verification_status, verified_at, verified_by, company_id from lp.contacts where id = any($1::bigint[])`,
      [ids],
    )
    const byId = new Map(contacts.map((c) => [Number(c.id), c]))
    const { rows: preRows } = await db.query<{ contact_id: number; email: string; result: string; verdict: string; raw: unknown }>(
      `select distinct on (contact_id) contact_id, email, result, verdict, raw
       from lp.verification_results where run_id = $1 and provider = 'precheck' and contact_id = any($2::bigint[])
       order by contact_id, id desc`,
      [id, ids],
    )
    const preById = new Map(preRows.map((p) => [Number(p.contact_id), p]))

    const checker = createPrechecker({ resolver: env.resolver })
    const ctx = { prechecker: checker, keys: env.keys, pricing: env.pricing, fetch: env.fetch }
    const worst = worstCaseCost(env.keys, env.pricing)

    let spent = run.spent_usd
    let reserved = 0
    let stopReason: string | null = null
    let haltReason: string | null = null
    const results: ContactResult[] = ids.map(() => ({ kind: 'not_started' }))

    const handle = async (i: number) => {
      const cid = ids[i]
      const c = byId.get(cid)
      if (!c || !c.email_norm) {
        results[i] = { kind: 'done', outcome: null, skip: 'missing' }
        return
      }
      // Verified after this run was previewed (another run, or an earlier step of this one): never pay twice.
      if (c.verified_at && new Date(c.verified_at) > runCreated && !run.summary?.options?.force) {
        results[i] = { kind: 'done', outcome: null, skip: 'already_verified' }
        return
      }
      const p = preById.get(cid)
      const pre: PrecheckResult | undefined =
        p && p.email === c.email_norm
          ? {
              email: p.email,
              domain: ((p.raw as { domain?: string } | null)?.domain ?? null) as string | null,
              verdict: p.verdict as PrecheckResult['verdict'],
              result: p.result as PrecheckResult['result'],
              flags: ((p.raw as { flags?: PrecheckResult['flags'] } | null)?.flags ?? {
                role: false,
                free_provider: false,
                disposable: false,
                implicit_mx: false,
              }) as PrecheckResult['flags'],
              mx: null,
            }
          : undefined
      const outcome = await runWaterfall(c.email_norm, ctx, pre, mvPending(c))
      const newStatus = nextContactStatus(c.status, outcome.final)
      await db.tx(async (t) => {
        for (const s of outcome.steps) await insertStep(t, cid, c.email_norm as string, id, s)
        if (outcome.final) {
          await t.query(
            `update lp.contacts set verification_status = $2, verified_at = now(), verified_by = $3, status = $4 where id = $1`,
            [cid, outcome.final, outcome.decided_by, newStatus],
          )
          await emitLeadEvent(t, {
            type: 'verified',
            contact_id: cid,
            company_id: c.company_id ?? null,
            source: 'verify',
            actor,
            props: { result: outcome.final, provider: outcome.decided_by },
          })
        }
        if (outcome.cost_usd > 0) {
          await t.query(`update lp.verification_runs set spent_usd = spent_usd + $2 where id = $1`, [id, outcome.cost_usd])
        }
      }, actor)
      spent = usd4(spent + outcome.cost_usd)
      results[i] = outcome.account_error ? { kind: 'account_error', outcome } : { kind: 'done', outcome }
      if (outcome.account_error && !haltReason) haltReason = outcome.account_error.message
    }

    let next = 0
    const worker = async () => {
      while (next < ids.length) {
        if (stopReason || haltReason) return
        if (Date.now() - started > timeBudgetMs) {
          stopReason = stopReason ?? 'time'
          return
        }
        // Reserve the worst case before starting: never cross the ceiling.
        // (MV + ZB; a contact going straight to ZB reserves the same, which is conservative.)
        if (worst > 0 && usd4(spent + reserved + worst) > max) {
          stopReason = 'cost_ceiling'
          return
        }
        const i = next++
        reserved = usd4(reserved + worst)
        try {
          await handle(i)
        } finally {
          reserved = usd4(reserved - worst)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker))

    // Contacts are started in order, so everything before the first unfinished one is done.
    let advance = results.findIndex((r) => r.kind !== 'done')
    if (advance === -1) advance = ids.length

    // Tally into the summary.
    const fresh = (await getRun(db, id)) as RunRow
    const summary: RunSummary = { ...(fresh.summary ?? {}) }
    const verdicts = { ...(summary.verdicts ?? {}) }
    const checks = { millionverifier: 0, zerobounce: 0, precheck_rejected: 0, ...(summary.checks ?? {}) }
    const notChecked = { mv_key_missing: 0, zb_key_missing: 0, provider_error: 0, already_verified: 0, missing: 0, ...(summary.not_checked ?? {}) }
    let spentNow = 0
    for (const r of results) {
      if (r.kind === 'not_started') continue
      if (r.kind === 'done' && r.skip) {
        bump(notChecked, r.skip)
        continue
      }
      const o = r.outcome as WaterfallOutcome
      spentNow += o.cost_usd
      if (o.final) bump(verdicts, o.final)
      if (o.stop === 'precheck_invalid') checks.precheck_rejected++
      for (const s of o.steps) {
        if (s.provider === 'millionverifier') checks.millionverifier++
        if (s.provider === 'zerobounce') checks.zerobounce++
      }
      if (o.stop === 'mv_key_missing') notChecked.mv_key_missing++
      if (o.stop === 'zb_key_missing') notChecked.zb_key_missing++
      if (o.stop === 'mv_error') notChecked.provider_error++
    }
    summary.verdicts = verdicts
    summary.checks = checks
    summary.not_checked = notChecked
    const processed = run.processed + advance
    const done = !haltReason && processed >= run.contact_count
    let status: RunStatus = 'running'
    let paused: string | null = null
    if (haltReason) {
      status = 'failed'
      summary.halted = haltReason
    } else if (done) {
      status = 'done'
    } else if (stopReason === 'cost_ceiling') {
      paused = `Stopped before crossing the ${money(max)} ceiling. Raise the ceiling to continue.`
    }
    summary.paused = paused

    const finalRun = await db.tx(async (t) => {
      await t.query(
        `update lp.verification_runs
           set processed = $2, status = $3, summary = $4,
               finished_at = case when $3 in ('done', 'failed') then now() else finished_at end
         where id = $1`,
        [id, processed, status, JSON.stringify(summary)],
      )
      const after = (await getRun(t, id)) as RunRow
      if (status === 'done' || status === 'failed') {
        const v = verdicts
        const notes: string[] = []
        if (notChecked.mv_key_missing) notes.push(`${notChecked.mv_key_missing} not checked (MillionVerifier key not set)`)
        if (notChecked.zb_key_missing) notes.push(`${notChecked.zb_key_missing} left at MillionVerifier's answer (ZeroBounce key not set)`)
        if (notChecked.provider_error) notes.push(`${notChecked.provider_error} MillionVerifier couldn't check`)
        const head =
          status === 'done'
            ? `Verification run #${id} finished: ${plural(processed, 'lead')}`
            : `Verification run #${id} stopped: ${haltReason} (${processed} of ${run.contact_count} done)`
        await logEvent(t, {
          actor,
          kind: status === 'done' ? 'verify.done' : 'verify.failed',
          summary:
            `${head}, ${v.valid ?? 0} valid, ${v.invalid ?? 0} invalid, ${v.catch_all ?? 0} catch-all, ` +
            `${(v.unknown ?? 0) + (v.risky ?? 0)} unknown/risky, ${money(after.spent_usd)} spent` +
            (notes.length ? `. ${notes.join('; ')}` : ''),
          entity_type: 'verification_run',
          entity_id: id,
          data: { verdicts: v, checks, not_checked: notChecked, spent_usd: after.spent_usd, max_cost_usd: max },
        })
      } else if (paused && !run.summary?.paused) {
        await logEvent(t, {
          actor: 'system',
          kind: 'verify.paused',
          summary: `Verification run #${id} paused at its ${money(max)} ceiling (${processed} of ${run.contact_count} done, ${money(after.spent_usd)} spent)`,
          entity_type: 'verification_run',
          entity_id: id,
        })
      }
      return after
    }, actor)

    return {
      run: finalRun,
      processed_now: advance,
      spent_now_usd: usd4(spentNow),
      done,
      paused,
      halted: haltReason,
    }
  } finally {
    await releaseStepLock(db, id)
  }
}

/**
 * How many contacts this run has given a verdict, e.g. 'valid'. null while the
 * run is a preview or before its first step (nothing tallied yet); once the
 * tally exists, a verdict missing from it is a counted zero.
 */
export function runVerdictCount(run: Pick<RunRow, 'status' | 'summary'>, verdict: string): number | null {
  if (run.status === 'preview') return null
  const v = run.summary?.verdicts
  if (!v) return null
  return typeof v[verdict] === 'number' ? v[verdict] : 0
}
