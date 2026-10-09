import type { Db, Queryable } from '../db/types.ts'
import { logEvent } from './events.ts'
import { OpsError } from './core.ts'

/**
 * Pause / stop an agent. Paused state lives in the database (migration 0008):
 *   lp.actors.paused_at / paused_by / pause_reason   one agent
 *   lp.agent_pause_all (one row)                     every agent ("Pause all")
 *
 * Only a human pauses or resumes, from the dashboard. A paused agent keeps its
 * tasks, claims, locks and memory exactly as they were; the ops gate
 * (lib/ops/gate.ts) refuses its requests until a human resumes it.
 * Every pause and resume is one row in the activity log.
 */

export interface PauseBlock {
  scope: 'agent' | 'all'
  /** Human actor id who paused, e.g. 'owner'. */
  by: string
  /** Their display name, e.g. 'Yaakov'. */
  by_name: string
  at: Date
  reason: string | null
}

const clean = (s: string | null | undefined) => {
  const t = (s ?? '').trim().slice(0, 500)
  return t || null
}

/** Is a request from this agent blocked right now? Agent pause first, then pause-all. */
export async function pauseBlockFor(q: Queryable, agentId: string): Promise<PauseBlock | null> {
  const { rows } = await q.query<{
    paused_at: Date | null; paused_by: string | null; pause_reason: string | null; by_name: string | null
    all_at: Date | null; all_by: string | null; all_reason: string | null; all_by_name: string | null
  }>(
    `select a.paused_at, a.paused_by, a.pause_reason, pb.display_name as by_name,
            s.paused_at as all_at, s.paused_by as all_by, s.reason as all_reason, sb.display_name as all_by_name
       from (select 1) one
       left join lp.actors a on a.id = $1
       left join lp.actors pb on pb.id = a.paused_by
       left join lp.agent_pause_all s on true
       left join lp.actors sb on sb.id = s.paused_by`,
    [agentId],
  )
  const r = rows[0]
  if (!r) return null
  if (r.paused_at && r.paused_by) return { scope: 'agent', by: r.paused_by, by_name: r.by_name ?? r.paused_by, at: new Date(r.paused_at), reason: r.pause_reason }
  if (r.all_at && r.all_by) return { scope: 'all', by: r.all_by, by_name: r.all_by_name ?? r.all_by, at: new Date(r.all_at), reason: r.all_reason }
  return null
}

/** The words an agent gets back when it is refused. */
export function pauseMessage(agentId: string, b: PauseBlock): string {
  const what = b.scope === 'all' ? `All agents are paused (agent paused by ${b.by_name})` : `${agentId} is paused (agent paused by ${b.by_name})`
  const why = b.reason ? `: "${b.reason}"` : ''
  return `${what}${why}. Nothing was done. Your tasks and claims are kept as they are; a human resumes you on the dashboard's Agents page.`
}

export interface PauseAllState {
  paused_at: Date
  paused_by: string
  by_name: string
  reason: string | null
}

export async function pauseAllState(q: Queryable): Promise<PauseAllState | null> {
  const { rows } = await q.query<PauseAllState>(
    `select s.paused_at, s.paused_by, coalesce(a.display_name, s.paused_by) as by_name, s.reason
       from lp.agent_pause_all s left join lp.actors a on a.id = s.paused_by`,
  )
  return rows[0] ?? null
}

async function humanName(q: Queryable, by: string): Promise<string> {
  const { rows } = await q.query<{ kind: string; display_name: string }>('select kind, display_name from lp.actors where id = $1', [by])
  if (rows[0]?.kind !== 'human') throw new OpsError('Only a person can pause or resume agents.', 403)
  return rows[0].display_name
}

async function agentRow(q: Queryable, id: string) {
  const { rows } = await q.query<{ id: string; kind: string; display_name: string; paused_at: Date | null; open_tasks: number }>(
    `select a.id, a.kind, a.display_name, a.paused_at,
            (select count(*)::int from lp.tasks t where t.claimed_by = a.id and t.status in ('claimed', 'running', 'blocked', 'needs_approval')) as open_tasks
       from lp.actors a where a.id = $1`,
    [id],
  )
  const a = rows[0]
  if (!a) throw new OpsError(`No actor '${id}'.`, 404)
  if (a.kind !== 'agent') throw new OpsError(`${a.display_name} is a person; only agents can be paused.`, 400)
  return a
}

export async function pauseAgent(db: Db, by: string, agentId: string, reason?: string | null): Promise<{ changed: boolean }> {
  return db.tx(async (q) => {
    const byName = await humanName(q, by)
    const a = await agentRow(q, agentId)
    const why = clean(reason)
    if (a.paused_at) return { changed: false }
    await q.query('update lp.actors set paused_at = now(), paused_by = $2, pause_reason = $3 where id = $1', [agentId, by, why])
    await logEvent(q, {
      actor: by,
      kind: 'agent.paused',
      summary: `${byName} paused ${a.display_name}${why ? `: ${why}` : ''}. Its ${a.open_tasks} open task${a.open_tasks === 1 ? '' : 's'} stay as they are.`,
      entity_type: 'actor',
      entity_id: agentId,
      data: { reason: why, open_tasks: a.open_tasks },
    })
    return { changed: true }
  }, by)
}

export async function resumeAgent(db: Db, by: string, agentId: string): Promise<{ changed: boolean }> {
  return db.tx(async (q) => {
    const byName = await humanName(q, by)
    const a = await agentRow(q, agentId)
    if (!a.paused_at) return { changed: false }
    const { rows } = await q.query<{ paused_at: Date; pause_reason: string | null }>(
      `update lp.actors n set paused_at = null, paused_by = null, pause_reason = null
         from lp.actors o where n.id = o.id and n.id = $1 returning o.paused_at, o.pause_reason`,
      [agentId],
    )
    await logEvent(q, {
      actor: by,
      kind: 'agent.resumed',
      summary: `${byName} resumed ${a.display_name}.`,
      entity_type: 'actor',
      entity_id: agentId,
      data: { was_paused_at: rows[0]?.paused_at ?? null, reason_was: rows[0]?.pause_reason ?? null },
    })
    return { changed: true }
  }, by)
}

export async function pauseAll(db: Db, by: string, reason?: string | null): Promise<{ changed: boolean }> {
  return db.tx(async (q) => {
    const byName = await humanName(q, by)
    const why = clean(reason)
    const r = await q.query('insert into lp.agent_pause_all (id, paused_by, reason) values (true, $1, $2) on conflict (id) do nothing returning id', [by, why])
    if (!r.rows.length) return { changed: false }
    await logEvent(q, {
      actor: by,
      kind: 'agent.paused_all',
      summary: `${byName} paused all agents${why ? `: ${why}` : ''}. Every agent's ops requests are refused until resumed.`,
      entity_type: 'actor',
      entity_id: '*',
      data: { reason: why },
    })
    return { changed: true }
  }, by)
}

export async function resumeAll(db: Db, by: string): Promise<{ changed: boolean }> {
  return db.tx(async (q) => {
    const byName = await humanName(q, by)
    const r = await q.query<{ paused_at: Date; reason: string | null }>('delete from lp.agent_pause_all returning paused_at, reason')
    if (!r.rows.length) return { changed: false }
    const still = await q.query<{ display_name: string }>("select display_name from lp.actors where kind = 'agent' and paused_at is not null order by display_name")
    const left = still.rows.map((x) => x.display_name)
    await logEvent(q, {
      actor: by,
      kind: 'agent.resumed_all',
      summary: `${byName} lifted "pause all agents".${left.length ? ` Still paused one by one: ${left.join(', ')}.` : ''}`,
      entity_type: 'actor',
      entity_id: '*',
      data: { was_paused_at: r.rows[0].paused_at, reason_was: r.rows[0].reason, still_paused: left },
    })
    return { changed: true }
  }, by)
}
