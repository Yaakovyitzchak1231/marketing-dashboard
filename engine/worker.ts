/**
 * The runner: claims find_leads / research_company tasks and works them.
 *
 * Two doors, same tasks:
 * - DATABASE_URL set: claims through lib/ops/core.ts (FOR UPDATE SKIP LOCKED +
 *   leases) and writes results straight into the lead hub. Needed for
 *   find_leads (its checkpoints live in lp.engine_*).
 * - Only OPS_URL + OPS_TOKEN set: claims/heartbeats/completes over the
 *   dashboard's ops API. research_company works this way (the ResearchResult
 *   rides complete_task's result.research for the server to apply);
 *   find_leads is refused because it needs the database for checkpoints.
 */
import type { Db } from '../lib/db/types.ts'
import { claimTask, completeTask, failTask, heartbeatTask, taskScopedDb, OpsError, type TaskRow } from '../lib/ops/core.ts'
import { applyResearchResult } from '../lib/research/apply.ts'
import { runFindLeads, type TaskControl } from './findLeads.ts'
import { normalizeFindParams } from './params.ts'
import { researchCompany, type ResearchPayload } from './research.ts'
import { searchProviderFromEnv, type SearchProvider } from './io/search.ts'
import { HostLimiter, request, sleep } from './io/http.ts'

export const ENGINE_KINDS = ['find_leads', 'research_company']

export interface WorkerOpts {
  agent: string
  kinds?: string[]
  once?: boolean
  pollSeconds?: number
  log?: (line: string) => void
  search?: SearchProvider | null
  shouldStop?: () => boolean
  /** Tests: swap the network, DNS and politeness. */
  fetch?: typeof request
  mx?: (domain: string) => Promise<string[] | 'nxdomain' | 'error'>
  politeness?: { gapMs?: number; retry429Ms?: number; backoffBaseMs?: number }
}

const LEASE = 600

export function dbControl(db: Db, agent: string, taskId: number, claimAttempt: number): TaskControl {
  return {
    async heartbeat(progress, note) {
      try {
        await heartbeatTask(db, agent, taskId, { progress, lease_seconds: LEASE, status_note: note, claim_attempt: claimAttempt })
        return 'ok'
      } catch (e) {
        if (e instanceof OpsError && [409, 423].includes(e.status)) return 'cancelled'
        throw e
      }
    },
  }
}

/** Work one claimed task with the database door. */
export async function workTaskDb(db: Db, t: TaskRow, opts: WorkerOpts): Promise<'done' | 'failed' | 'cancelled'> {
  const log = opts.log ?? console.log
  const search = opts.search === undefined ? searchProviderFromEnv() : opts.search
  const control = dbControl(db, opts.agent, t.id, t.attempts)
  try {
    if (await control.heartbeat({ step: 'starting' }) === 'cancelled') return 'cancelled'
    const scopedDb = taskScopedDb(db, opts.agent, t.id, t.attempts)
    if (t.kind === 'find_leads') {
      const params = normalizeFindParams(t.payload)
      const out = await runFindLeads(scopedDb, t.id, params, { agent: opts.agent, control, search, log, fetch: opts.fetch, mx: opts.mx, politeness: opts.politeness })
      if (out.status === 'cancelled') return 'cancelled'
      await completeTask(db, opts.agent, t.id, { result: { run_id: out.run_id, counters: out.counters }, report: out.report, claim_attempt: t.attempts })
      log(out.report)
      return 'done'
    }
    if (t.kind === 'research_company') {
      if (!t.company_id) throw new Error('research_company task has no company_id')
      if (await control.heartbeat({ step: 'reading the website' }) === 'cancelled') return 'cancelled'
      const payload = t.payload as unknown as ResearchPayload
      const r = await researchCompany(t.company_id, payload, {
        runner: 'engine',
        search,
        useProxies: Boolean((t.payload as Record<string, unknown>).proxies),
        mx: opts.mx,
        crawlDeps: { fetchPage: opts.fetch, retry429Ms: opts.politeness?.retry429Ms, backoffBaseMs: opts.politeness?.backoffBaseMs, ...(opts.politeness?.gapMs != null ? { limiter: new HostLimiter(1, opts.politeness.gapMs) } : {}) },
      })
      const completion: NonNullable<Parameters<typeof completeTask>[3]> = { report: r.summary, claim_attempt: t.attempts }
      completion.prepareResult = async (q) => {
        const applied = await applyResearchResult({ query: q.query.bind(q), tx: (fn) => fn(q) }, r, opts.agent, { task_id: t.id, claim_attempt: t.attempts })
        completion.report = `${r.summary}. ${applied.contacts_created} new email${applied.contacts_created === 1 ? '' : 's'} added${applied.owner_set ? `, owner set to ${applied.owner_set}` : ''}.`
        return { research: r, applied }
      }
      await completeTask(db, opts.agent, t.id, completion)
      log(completion.report!)
      return 'done'
    }
    throw new Error(`the engine does not handle task kind '${t.kind}'`)
  } catch (e) {
    if (e instanceof OpsError && [409, 423].includes(e.status)) return 'cancelled'
    const msg = (e as Error).message || String(e)
    log(`task ${t.id} failed: ${msg}`)
    await failTask(db, opts.agent, t.id, { error: msg, claim_attempt: t.attempts }).catch(() => undefined)
    return 'failed'
  }
}

export async function runWorkerDb(db: Db, opts: WorkerOpts): Promise<number> {
  const log = opts.log ?? console.log
  const kinds = opts.kinds?.length ? opts.kinds : ENGINE_KINDS
  let worked = 0
  for (;;) {
    if (opts.shouldStop?.()) break
    const t = await claimTask(db, opts.agent, { kinds, lease_seconds: LEASE })
    if (!t) {
      if (opts.once) break
      await sleep((opts.pollSeconds ?? 30) * 1000)
      continue
    }
    log(`claimed task ${t.id} (${t.kind}): ${t.title}`)
    await workTaskDb(db, t, opts)
    worked++
    if (opts.once) break
  }
  return worked
}

// ----------------------------------------------------------- ops API door

export interface OpsApi {
  call<T>(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data?: T; error?: string }>
}

export function opsApiFromEnv(env: NodeJS.ProcessEnv = process.env): OpsApi | null {
  if (!env.OPS_URL || !env.OPS_TOKEN) return null
  const base = env.OPS_URL.replace(/\/$/, '')
  const token = env.OPS_TOKEN
  return {
    async call<T>(path: string, body: Record<string, unknown>) {
      const r = await request(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 30_000,
      })
      let j: { ok?: boolean; data?: T; error?: string } = {}
      try {
        j = JSON.parse(r.body)
      } catch {
        j = { ok: false, error: `HTTP ${r.status}` }
      }
      return { ok: Boolean(j.ok), status: r.status, data: j.data, error: j.error }
    },
  }
}

export async function runWorkerApi(api: OpsApi, opts: WorkerOpts): Promise<number> {
  const log = opts.log ?? console.log
  const search = opts.search === undefined ? searchProviderFromEnv() : opts.search
  let worked = 0
  for (;;) {
    if (opts.shouldStop?.()) break
    const claim = await api.call<TaskRow | null>('/api/ops/tasks/claim', { agent: opts.agent, kinds: ['research_company'], lease_seconds: LEASE })
    if (!claim.ok) throw new Error(`ops API claim failed: ${claim.error ?? claim.status}`)
    const t = claim.data ?? null
    if (!t) {
      if (opts.once) break
      await sleep((opts.pollSeconds ?? 30) * 1000)
      continue
    }
    log(`claimed task ${t.id} (${t.kind}) via the ops API`)
    try {
      if (!t.company_id) throw new Error('research_company task has no company_id')
      const heartbeat = await api.call(`/api/ops/tasks/${t.id}/heartbeat`, { agent: opts.agent, progress: { step: 'reading the website' }, lease_seconds: LEASE, claim_attempt: t.attempts })
      if (!heartbeat.ok) throw new Error(`heartbeat refused: ${heartbeat.status}`)
      const r = await researchCompany(t.company_id, t.payload as unknown as ResearchPayload, { runner: opts.agent, search })
      const done = await api.call(`/api/ops/tasks/${t.id}/complete`, { agent: opts.agent, result: { research: r }, report: r.summary, claim_attempt: t.attempts })
      if (!done.ok) throw new Error(`complete failed: ${done.error}`)
      log(r.summary)
    } catch (e) {
      await api.call(`/api/ops/tasks/${t.id}/fail`, { agent: opts.agent, error: (e as Error).message, claim_attempt: t.attempts }).catch(() => undefined)
    }
    worked++
    if (opts.once) break
  }
  return worked
}
