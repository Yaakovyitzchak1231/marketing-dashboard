/**
 * runAction: execute one library action and record it in lp.step_log.
 * Every execution writes exactly one step-log row (ok, failed, or skipped),
 * so there is always an audit trail of what a journey step did to a lead.
 */
import type { Db, Queryable } from '../db/types.ts'
import { ActionError, getAction, type ActionDef, type ActionMinRole } from './registry.ts'

const ROLE_RANK: Record<ActionMinRole, number> = { viewer: 0, editor: 1, owner: 2 }

/**
 * Enforce a library action's minimum role, inside runAction so the check
 * cannot be bypassed by calling run_action (one op) for a restricted action.
 * Agents are refused outright for anything above 'viewer'; the built-in
 * 'system' runner and the 'owner' human are exempt. Unknown actors fail closed.
 */
async function checkActionRole(db: Db, actor: string, action: ActionDef): Promise<void> {
  const min = action.min_role ?? 'viewer'
  if (min === 'viewer') return
  if (actor === 'system' || actor === 'owner') return
  const { rows } = await db.query<{ kind: string; role: string | null }>(
    `select kind, to_jsonb(a)->>'role' as role from lp.actors a where id = $1`,
    [actor],
  )
  const row = rows[0]
  if (!row || row.kind !== 'human') {
    throw new ActionError(`Action ${action.key} needs a human with ${min} access or above; agent keys get 403.`, 403)
  }
  const rank = row.role != null ? ROLE_RANK[row.role as ActionMinRole] : undefined
  if (rank === undefined || rank < ROLE_RANK[min]) {
    throw new ActionError(`Action ${action.key} needs ${min} access or above.`, 403)
  }
}

export type StepStatus = 'ok' | 'failed' | 'skipped'

export interface StepContext {
  campaign_id?: number | null
  /** Node id inside the journey definition (e.g. 'n3' or 'ab_split:n1'). */
  step_key?: string | null
  company_id?: number | null
  contact_id?: number | null
  /**
   * Optional idempotency key: when given, a repeat call with the same key
   * returns the earlier 'ok' result instead of re-running the action.
   */
  idempotency_key?: string | null
}

export interface StepLogRow {
  id: number
  campaign_id: number | null
  step_key: string
  company_id: number | null
  contact_id: number | null
  action: string
  status: StepStatus
  input: Record<string, unknown>
  result: Record<string, unknown>
  error: string | null
  actor: string | null
  created_at: Date
}

function logRow(r: Record<string, unknown>): StepLogRow {
  return {
    id: Number(r.id),
    campaign_id: r.campaign_id == null ? null : Number(r.campaign_id),
    step_key: String(r.step_key),
    company_id: r.company_id == null ? null : Number(r.company_id),
    contact_id: r.contact_id == null ? null : Number(r.contact_id),
    action: String(r.action),
    status: r.status as StepStatus,
    input: r.input as Record<string, unknown>,
    result: r.result as Record<string, unknown>,
    error: r.error == null ? null : String(r.error),
    actor: r.actor == null ? null : String(r.actor),
    created_at: new Date(String(r.created_at)),
  }
}

async function writeLog(
  q: Queryable,
  e: {
    campaign_id: number | null
    step_key: string
    company_id: number | null
    contact_id: number | null
    action: string
    status: StepStatus
    input: Record<string, unknown>
    result: Record<string, unknown>
    error: string | null
    actor: string
  },
): Promise<StepLogRow> {
  const r = await q.query<Record<string, unknown>>(
    `insert into lp.step_log (campaign_id, step_key, company_id, contact_id, action, status, input, result, error, actor)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10) returning *`,
    [
      e.campaign_id,
      e.step_key,
      e.company_id,
      e.contact_id,
      e.action,
      e.status,
      JSON.stringify(e.input),
      JSON.stringify(e.result),
      e.error,
      e.actor,
    ],
  )
  return logRow(r.rows[0])
}

export interface RunActionResult {
  action: string
  status: StepStatus
  result: unknown
  /** Null when the action ran but its audit row could not be written. */
  log_id: number | null
  /** Set when the audit row failed after the action succeeded. */
  log_warning?: string
  /** True when an idempotency key replayed an earlier 'ok' result. */
  deduped?: boolean
}

/**
 * Run a library action for a journey step. The action runs inside a
 * transaction with its log row; a failed action still leaves its row
 * (status 'failed' with the error), so failures are visible, not silent.
 */
export async function runAction(
  db: Db,
  actor: string,
  key: string,
  args: Record<string, unknown>,
  ctx: StepContext = {},
): Promise<RunActionResult> {
  const action = getAction(key) // throws ActionError on unknown keys, before any logging
  await checkActionRole(db, actor, action)
  const stepKey = (ctx.step_key ?? 'manual').toString().slice(0, 120) || 'manual'
  const idemKey = (ctx.idempotency_key ?? '').toString().trim() || null
  const base = {
    campaign_id: ctx.campaign_id ?? null,
    step_key: stepKey,
    company_id: ctx.company_id ?? null,
    contact_id: ctx.contact_id ?? null,
    action: key,
    actor,
  }
  // Idempotency: a repeat call with the same key returns the earlier 'ok'
  // result instead of re-running (the key is stored namespaced in the logged
  // input, so the lookup needs no schema change).
  if (idemKey) {
    const prior = await findOkByIdempotencyKey(db, base, idemKey)
    if (prior) return { action: key, status: 'ok', result: prior.result, log_id: prior.id, deduped: true }
  }
  const loggedInput = idemKey ? { ...args, _idempotency_key: idemKey } : args
  // NOTE: no outer db.tx here. The wrapped writers (createTask, updateEntity,
  // addSuppression, addTag/removeTag) each manage their own transaction; nesting
  // a second tx around them deadlocks PGlite and breaks savepoint-less clients.
  // The action runs first, then its audit row is written: success leaves one
  // 'ok' row, failure leaves one 'failed' row with the error. If the audit row
  // itself fails after the action succeeded, report honestly ("done but not
  // logged") instead of a 500 that invites a double-executing retry.
  try {
    const out = await action.run(db, actor, args)
    try {
      const logged = await writeLog(db, {
        ...base,
        status: 'ok',
        input: loggedInput,
        result: (out ?? {}) as Record<string, unknown>,
        error: null,
      })
      return { action: key, status: 'ok', result: out, log_id: logged.id }
    } catch (logErr) {
      const message = logErr instanceof Error ? logErr.message : String(logErr)
      return {
        action: key,
        status: 'ok',
        result: out,
        log_id: null,
        log_warning: `done but not logged: ${message}`,
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const logged = await writeLog(db, { ...base, status: 'failed', input: loggedInput, result: {}, error: message })
    if (e instanceof ActionError) throw e
    throw new ActionError(`Action ${key} failed: ${message}`)
  }
}

/** Latest 'ok' step_log row for these coordinates carrying this idempotency key. */
async function findOkByIdempotencyKey(
  db: Db,
  base: { campaign_id: number | null; step_key: string; company_id: number | null; contact_id: number | null; action: string },
  idemKey: string,
): Promise<StepLogRow | null> {
  const { rows } = await db.query<Record<string, unknown>>(
    `select * from lp.step_log
      where status = 'ok'
        and campaign_id is not distinct from $1
        and step_key = $2
        and company_id is not distinct from $3
        and contact_id is not distinct from $4
        and action = $5
        and input->>'_idempotency_key' = $6
      order by id desc
      limit 1`,
    [base.campaign_id, base.step_key, base.company_id, base.contact_id, base.action, idemKey],
  )
  return rows.length ? logRow(rows[0]) : null
}

/** Recent step-log rows for a campaign, newest first (the campaign page reads this). */
export async function listStepLog(
  q: Queryable,
  f: { campaign_id?: number | null; company_id?: number | null; action?: string | null; limit?: number } = {},
): Promise<StepLogRow[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (f.campaign_id != null) {
    where.push(`campaign_id = $${params.length + 1}`)
    params.push(f.campaign_id)
  }
  if (f.company_id != null) {
    where.push(`company_id = $${params.length + 1}`)
    params.push(f.company_id)
  }
  if (f.action) {
    where.push(`action = $${params.length + 1}`)
    params.push(f.action)
  }
  const limit = Math.min(Math.max(Math.floor(Number(f.limit) || 50), 1), 200)
  const r = await q.query<Record<string, unknown>>(
    `select * from lp.step_log ${where.length ? `where ${where.join(' and ')}` : ''} order by id desc limit ${limit}`,
    params,
  )
  return r.rows.map(logRow)
}
