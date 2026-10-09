/**
 * The co-working layer: one set of operations used by humans (through the
 * dashboard) and by agents (through the ops API) alike. Every write lands in
 * the same database and logs one plain-English event.
 *
 * Library-book rules:
 *  - A task is claimed by one actor at a time, with a lease. The claimer
 *    heartbeats to keep it; an expired lease lets someone else pick it up.
 *  - A lock on a resource (a campaign, a lead list, a company) has one holder
 *    and a lease. Others see who holds it and wait.
 *  - Anything outward or paid is requested as an approval; only a human
 *    decides it, and never the actor who asked.
 */
import type { Db, Queryable } from '../db/types.ts'
import { logEvent } from './events.ts'

export class OpsError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export interface Actor {
  id: string
  kind: 'human' | 'agent'
  display_name: string
}

export interface TaskRow {
  id: number
  project_id: number | null
  kind: string
  title: string
  status: string
  priority: number
  assigned_to: string | null
  claimed_by: string | null
  lease_expires_at: Date | null
  heartbeat_at: Date | null
  attempts: number
  max_attempts: number
  company_id: number | null
  payload: Record<string, unknown>
  result: unknown
  report: string | null
  handoff_note: string | null
  error: string | null
  dedupe_key: string | null
  created_by: string | null
  created_at: Date
  updated_at: Date
  finished_at: Date | null
}

const LIVE = ['queued', 'claimed', 'running', 'blocked', 'needs_approval']
const DEFAULT_LEASE = 300
const MAX_LEASE = 3600

function lease(seconds: unknown): number {
  const n = Number(seconds ?? DEFAULT_LEASE)
  if (!Number.isFinite(n) || n < 15) return DEFAULT_LEASE
  return Math.min(Math.floor(n), MAX_LEASE)
}

function nonEmpty(v: unknown, field: string, max = 500): string {
  if (typeof v !== 'string' || !v.trim()) throw new OpsError(`${field} is required`)
  return v.trim().slice(0, max)
}

export async function getActor(q: Queryable, id: string): Promise<Actor | null> {
  const { rows } = await q.query<Actor>('select id, kind, display_name from lp.actors where id = $1 and active', [id])
  return rows[0] ?? null
}

async function name(q: Queryable, id: string | null): Promise<string> {
  if (!id) return 'Someone'
  const a = await getActor(q, id)
  return a?.display_name ?? id
}

async function requireActor(q: Queryable, id: string): Promise<Actor> {
  const a = await getActor(q, id)
  if (!a) throw new OpsError(`unknown or inactive actor '${id}'`, 403)
  return a
}

/** Presence: every call an actor makes marks them as seen. */
export async function touchActor(q: Queryable, actor: string, statusNote?: string | null): Promise<void> {
  if (statusNote === undefined) {
    await q.query('update lp.actors set last_seen_at = now() where id = $1', [actor])
  } else {
    await q.query('update lp.actors set last_seen_at = now(), status_note = $2 where id = $1', [actor, statusNote ? statusNote.slice(0, 280) : null])
  }
}

async function notify(
  q: Queryable,
  n: { recipient: string; kind: string; summary: string; task_id?: number | null; comment_id?: number | null; created_by: string },
): Promise<void> {
  if (n.recipient === n.created_by) return
  await q.query(
    `insert into lp.notifications (recipient, kind, summary, task_id, comment_id, created_by)
     select $1, $2, $3, $4, $5, $6 where exists (select 1 from lp.actors where id = $1)`,
    [n.recipient, n.kind, n.summary.slice(0, 500), n.task_id ?? null, n.comment_id ?? null, n.created_by],
  )
}

async function loadTask(q: Queryable, id: number, forUpdate = false): Promise<TaskRow> {
  const { rows } = await q.query<TaskRow>(`select * from lp.tasks where id = $1${forUpdate ? ' for update' : ''}`, [id])
  if (!rows[0]) throw new OpsError(`task ${id} not found`, 404)
  return rows[0]
}

// ---------------------------------------------------------------- tasks

export interface CreateTaskInput {
  kind?: string
  title: string
  project_id?: number | null
  assigned_to?: string | null
  company_id?: number | null
  payload?: Record<string, unknown>
  priority?: number
  dedupe_key?: string | null
  max_attempts?: number
  /** First comment / instructions, shown on the task thread. */
  body?: string | null
}

export async function createTask(db: Db, actor: string, input: CreateTaskInput): Promise<TaskRow> {
  return db.tx(async (q) => {
    await requireActor(q, actor)
    const title = nonEmpty(input.title, 'title', 300)
    if (input.assigned_to) await requireActor(q, input.assigned_to)
    let row: TaskRow
    try {
      const { rows } = await q.query<TaskRow>(
        `insert into lp.tasks (kind, title, project_id, assigned_to, company_id, payload, priority, dedupe_key, max_attempts, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [
          (input.kind || 'general').slice(0, 60),
          title,
          input.project_id ?? null,
          input.assigned_to ?? null,
          input.company_id ?? null,
          JSON.stringify(input.payload ?? {}),
          Number.isFinite(input.priority) ? Math.trunc(input.priority as number) : 0,
          input.dedupe_key ?? null,
          Number.isFinite(input.max_attempts) ? Math.max(1, Math.trunc(input.max_attempts as number)) : 3,
          actor,
        ],
      )
      row = rows[0]
    } catch (e) {
      if (input.dedupe_key && /tasks_dedupe_live_uq|duplicate key/.test(String((e as Error).message))) {
        throw new OpsError(`a live task already exists for '${input.dedupe_key}'`, 409)
      }
      throw e
    }
    const who = await name(q, actor)
    const to = input.assigned_to ? await name(q, input.assigned_to) : null
    await logEvent(q, {
      actor,
      kind: 'task.created',
      summary: to ? `${who} assigned "${title}" to ${to}` : `${who} added "${title}" to the board`,
      entity_type: 'task',
      entity_id: row.id,
      task_id: row.id,
    })
    if (input.body && input.body.trim()) await addComment(q, actor, { task_id: row.id, body: input.body, kind: 'comment' })
    if (input.assigned_to) {
      await notify(q, { recipient: input.assigned_to, kind: 'assigned', summary: `${who} assigned you "${title}"`, task_id: row.id, created_by: actor })
    }
    return row
  }, actor)
}

/**
 * Claim the next task this actor may do: queued (or a live task whose lease
 * expired), assigned to this actor or to nobody, optionally of given kinds.
 * FOR UPDATE SKIP LOCKED means two agents asking at once never get the same row.
 */
export async function claimTask(
  db: Db,
  actor: string,
  opts: { kinds?: string[]; task_id?: number; lease_seconds?: number } = {},
): Promise<TaskRow | null> {
  return db.tx(async (q) => {
    await requireActor(q, actor)
    const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds.map(String) : null
    const { rows } = await q.query<TaskRow>(
      `update lp.tasks t set status = 'claimed', claimed_by = $1, heartbeat_at = now(),
              lease_expires_at = now() + make_interval(secs => $2), attempts = t.attempts + 1
        where t.id = (
          select id from lp.tasks
           where (assigned_to is null or assigned_to = $1)
             and ($3::text[] is null or kind = any($3))
             and ($4::bigint is null or id = $4)
             and attempts < max_attempts
             and (status = 'queued'
                  or (status in ('claimed', 'running') and lease_expires_at < now()))
           order by priority desc, id
           limit 1
           for update skip locked)
        returning t.*`,
      [actor, lease(opts.lease_seconds), kinds, opts.task_id ?? null],
    )
    await touchActor(q, actor)
    const t = rows[0] ?? null
    if (t) {
      const who = await name(q, actor)
      await logEvent(q, { actor, kind: 'task.claimed', summary: `${who} picked up "${t.title}"`, entity_type: 'task', entity_id: t.id, task_id: t.id })
      if (t.company_id) await q.query("update lp.companies set research_status = 'researching' where id = $1 and $2 = 'research_company'", [t.company_id, t.kind])
    }
    return t
  }, actor)
}

function assertHolder(t: TaskRow, actor: string) {
  if (t.claimed_by !== actor) throw new OpsError(`task ${t.id} is not claimed by ${actor}${t.claimed_by ? ` (held by ${t.claimed_by})` : ''}`, 409)
  if (!['claimed', 'running', 'blocked'].includes(t.status)) throw new OpsError(`task ${t.id} is ${t.status}`, 409)
}

export async function heartbeatTask(
  db: Db,
  actor: string,
  id: number,
  opts: { lease_seconds?: number; progress?: unknown; status_note?: string } = {},
): Promise<TaskRow> {
  return db.tx(async (q) => {
    const t = await loadTask(q, id, true)
    assertHolder(t, actor)
    const { rows } = await q.query<TaskRow>(
      `update lp.tasks set status = case when status = 'claimed' then 'running' else status end,
              heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => $2),
              result = case when $3::jsonb is null then result
                            else coalesce(case when jsonb_typeof(result) = 'object' then result end, '{}'::jsonb) || jsonb_build_object('progress', $3::jsonb) end
        where id = $1 returning *`,
      [id, lease(opts.lease_seconds), opts.progress === undefined ? null : JSON.stringify(opts.progress)],
    )
    await touchActor(q, actor, opts.status_note)
    return rows[0]
  }, actor)
}

export async function completeTask(db: Db, actor: string, id: number, opts: { result?: unknown; report?: string } = {}): Promise<TaskRow> {
  return db.tx(async (q) => {
    const t = await loadTask(q, id, true)
    assertHolder(t, actor)
    const report = typeof opts.report === 'string' ? opts.report.slice(0, 20000) : null
    const { rows } = await q.query<TaskRow>(
      `update lp.tasks set status = 'done', finished_at = now(), lease_expires_at = null,
              result = coalesce($2::jsonb, result), report = coalesce($3, report), error = null
        where id = $1 returning *`,
      [id, opts.result === undefined ? null : JSON.stringify(opts.result), report],
    )
    const who = await name(q, actor)
    if (report) await addComment(q, actor, { task_id: id, body: report, kind: 'report' })
    await logEvent(q, { actor, kind: 'task.done', summary: `${who} finished "${t.title}"`, entity_type: 'task', entity_id: id, task_id: id })
    if (t.created_by) await notify(q, { recipient: t.created_by, kind: 'task_update', summary: `${who} finished "${t.title}"`, task_id: id, created_by: actor })
    await touchActor(q, actor)
    return rows[0]
  }, actor)
}

export async function failTask(db: Db, actor: string, id: number, opts: { error: string; retry?: boolean }): Promise<TaskRow> {
  return db.tx(async (q) => {
    const t = await loadTask(q, id, true)
    assertHolder(t, actor)
    const error = nonEmpty(opts.error, 'error', 4000)
    const retry = opts.retry !== false && t.attempts < t.max_attempts
    const { rows } = await q.query<TaskRow>(
      `update lp.tasks set status = $2, claimed_by = case when $2 = 'queued' then null else claimed_by end,
              lease_expires_at = null, error = $3, finished_at = case when $2 = 'failed' then now() else null end
        where id = $1 returning *`,
      [id, retry ? 'queued' : 'failed', error],
    )
    const who = await name(q, actor)
    await logEvent(q, {
      actor,
      kind: retry ? 'task.retry' : 'task.failed',
      summary: retry ? `${who} hit a problem on "${t.title}" and put it back in the queue: ${error.slice(0, 200)}` : `${who} could not finish "${t.title}": ${error.slice(0, 200)}`,
      entity_type: 'task',
      entity_id: id,
      task_id: id,
    })
    if (!retry && t.created_by) await notify(q, { recipient: t.created_by, kind: 'task_update', summary: `"${t.title}" failed: ${error.slice(0, 200)}`, task_id: id, created_by: actor })
    return rows[0]
  }, actor)
}

/** Hand a task to someone else (human or agent) with a note. */
export async function handoffTask(db: Db, actor: string, id: number, opts: { to: string; note: string }): Promise<TaskRow> {
  return db.tx(async (q) => {
    const me = await requireActor(q, actor)
    const t = await loadTask(q, id, true)
    if (!LIVE.includes(t.status)) throw new OpsError(`task ${id} is ${t.status}`, 409)
    if (me.kind === 'agent' && t.claimed_by && t.claimed_by !== actor) throw new OpsError(`task ${id} is held by ${t.claimed_by}`, 409)
    await requireActor(q, opts.to)
    const note = nonEmpty(opts.note, 'note', 4000)
    const { rows } = await q.query<TaskRow>(
      `update lp.tasks set assigned_to = $2, claimed_by = null, lease_expires_at = null, status = 'queued', handoff_note = $3
        where id = $1 returning *`,
      [id, opts.to, note],
    )
    const who = me.display_name
    const to = await name(q, opts.to)
    const c = await addComment(q, actor, { task_id: id, body: note, kind: 'handoff' })
    await logEvent(q, { actor, kind: 'task.handoff', summary: `${who} handed "${t.title}" to ${to}: ${note.slice(0, 160)}`, entity_type: 'task', entity_id: id, task_id: id })
    await notify(q, { recipient: opts.to, kind: 'handoff', summary: `${who} handed you "${t.title}"`, task_id: id, comment_id: c.id, created_by: actor })
    return rows[0]
  }, actor)
}

/** Human-side edits: cancel, block, re-queue, reassign, reprioritize. */
export async function updateTask(
  db: Db,
  actor: string,
  id: number,
  patch: { status?: 'queued' | 'blocked' | 'cancelled' | 'done'; assigned_to?: string | null; priority?: number; title?: string },
): Promise<TaskRow> {
  return db.tx(async (q) => {
    const me = await requireActor(q, actor)
    const t = await loadTask(q, id, true)
    if (me.kind === 'agent' && t.claimed_by && t.claimed_by !== actor) throw new OpsError(`task ${id} is held by ${t.claimed_by}`, 409)
    if (patch.status && !['queued', 'blocked', 'cancelled', 'done'].includes(patch.status)) throw new OpsError('bad status')
    if (patch.assigned_to) await requireActor(q, patch.assigned_to)
    const { rows } = await q.query<TaskRow>(
      `update lp.tasks set
         status = coalesce($2, status),
         claimed_by = case when $2 in ('queued', 'cancelled') then null else claimed_by end,
         lease_expires_at = case when $2 is not null then null else lease_expires_at end,
         finished_at = case when $2 in ('cancelled', 'done') then now() else finished_at end,
         assigned_to = case when $3 then $4 else assigned_to end,
         priority = coalesce($5, priority),
         title = coalesce($6, title)
       where id = $1 returning *`,
      [id, patch.status ?? null, 'assigned_to' in patch, patch.assigned_to ?? null, Number.isFinite(patch.priority) ? patch.priority : null, patch.title?.trim() || null],
    )
    const parts: string[] = []
    if (patch.status) parts.push(`marked it ${patch.status}`)
    if ('assigned_to' in patch) parts.push(patch.assigned_to ? `assigned it to ${await name(q, patch.assigned_to)}` : 'unassigned it')
    if (patch.priority !== undefined) parts.push(`set priority ${patch.priority}`)
    if (patch.title) parts.push('renamed it')
    await logEvent(q, { actor, kind: 'task.updated', summary: `${me.display_name} ${parts.join(', ') || 'edited'} "${rows[0].title}"`, entity_type: 'task', entity_id: id, task_id: id })
    if (patch.assigned_to) await notify(q, { recipient: patch.assigned_to, kind: 'assigned', summary: `${me.display_name} assigned you "${rows[0].title}"`, task_id: id, created_by: actor })
    return rows[0]
  }, actor)
}

// ---------------------------------------------------------------- comments & mentions

/** @tab, @hermes, @owner ... -> actor ids that exist. */
export function parseMentions(body: string): string[] {
  const out = new Set<string>()
  for (const m of body.matchAll(/(^|[^\w@.])@([a-z0-9][a-z0-9_.-]{0,62})/gi)) out.add(m[2].toLowerCase().replace(/[.]+$/, ''))
  return [...out]
}

export async function addComment(
  q: Queryable,
  actor: string,
  c: { task_id?: number | null; company_id?: number | null; body: string; kind?: 'comment' | 'handoff' | 'report' | 'system' },
): Promise<{ id: number; mentions: string[] }> {
  const body = nonEmpty(c.body, 'body', 20000)
  if (!c.task_id && !c.company_id) throw new OpsError('task_id or company_id is required')
  const candidates = parseMentions(body)
  let mentions: string[] = []
  if (candidates.length) {
    const { rows } = await q.query<{ id: string }>('select id from lp.actors where id = any($1) and active', [candidates])
    mentions = rows.map((r) => r.id)
  }
  const { rows } = await q.query<{ id: number }>(
    'insert into lp.comments (task_id, company_id, author, body, kind, mentions) values ($1, $2, $3, $4, $5, $6) returning id',
    [c.task_id ?? null, c.company_id ?? null, actor, body, c.kind ?? 'comment', mentions],
  )
  const id = rows[0].id
  const who = await name(q, actor)
  let where = ''
  if (c.task_id) {
    const t = await q.query<{ title: string }>('select title from lp.tasks where id = $1', [c.task_id])
    where = t.rows[0] ? ` on "${t.rows[0].title}"` : ''
  } else if (c.company_id) {
    const co = await q.query<{ name: string }>('select name from lp.companies where id = $1', [c.company_id])
    where = co.rows[0] ? ` on ${co.rows[0].name}` : ''
  }
  for (const m of mentions) {
    await notify(q, { recipient: m, kind: 'mention', summary: `${who} mentioned you${where}: ${body.slice(0, 160)}`, task_id: c.task_id ?? null, comment_id: id, created_by: actor })
  }
  if ((c.kind ?? 'comment') === 'comment') {
    await logEvent(q, {
      actor,
      kind: 'comment.added',
      summary: `${who} commented${where}: ${body.slice(0, 160)}`,
      entity_type: c.task_id ? 'task' : 'company',
      entity_id: c.task_id ?? c.company_id ?? null,
      task_id: c.task_id ?? null,
    })
  }
  return { id, mentions }
}

export async function comment(db: Db, actor: string, c: { task_id?: number | null; company_id?: number | null; body: string }) {
  return db.tx(async (q) => {
    await requireActor(q, actor)
    await touchActor(q, actor)
    return addComment(q, actor, { ...c, kind: 'comment' })
  }, actor)
}

// ---------------------------------------------------------------- locks

export interface LockRow {
  resource: string
  holder: string
  task_id: number | null
  note: string | null
  acquired_at: Date
  heartbeat_at: Date
  lease_expires_at: Date
}

function resourceName(r: unknown): string {
  const s = nonEmpty(r, 'resource', 200)
  if (!/^[a-z_]+:.+$/i.test(s)) throw new OpsError("resource must look like 'campaign:<id>', 'company:<id>' or 'list:<name>'")
  return s
}

/** Take a lock, or learn who holds it. Re-acquiring your own lock renews it. */
export async function acquireLock(
  db: Db,
  actor: string,
  opts: { resource: string; lease_seconds?: number; note?: string; task_id?: number | null },
): Promise<{ ok: true; lock: LockRow } | { ok: false; held_by: LockRow }> {
  return db.tx(async (q) => {
    await requireActor(q, actor)
    const resource = resourceName(opts.resource)
    const { rows } = await q.query<LockRow>(
      `insert into lp.locks (resource, holder, task_id, note, lease_expires_at)
       values ($1, $2, $3, $4, now() + make_interval(secs => $5))
       on conflict (resource) do update set holder = excluded.holder, task_id = excluded.task_id, note = excluded.note,
              heartbeat_at = now(), lease_expires_at = excluded.lease_expires_at,
              acquired_at = case when lp.locks.holder = excluded.holder then lp.locks.acquired_at else now() end
        where lp.locks.holder = excluded.holder or lp.locks.lease_expires_at < now()
       returning *`,
      [resource, actor, opts.task_id ?? null, opts.note?.slice(0, 500) ?? null, lease(opts.lease_seconds)],
    )
    await touchActor(q, actor)
    if (rows[0]) {
      const fresh = rows[0].acquired_at.getTime() >= rows[0].heartbeat_at.getTime() - 1000
      if (fresh) {
        await logEvent(q, { actor, kind: 'lock.acquired', summary: `${await name(q, actor)} checked out ${resource}${opts.note ? ` (${opts.note.slice(0, 120)})` : ''}`, entity_type: 'lock', entity_id: resource, task_id: opts.task_id ?? null })
      }
      return { ok: true as const, lock: rows[0] }
    }
    const held = await q.query<LockRow>('select * from lp.locks where resource = $1', [resource])
    return { ok: false as const, held_by: held.rows[0] }
  }, actor)
}

export async function releaseLock(db: Db, actor: string, opts: { resource: string; force?: boolean }): Promise<{ released: boolean }> {
  return db.tx(async (q) => {
    const me = await requireActor(q, actor)
    const resource = resourceName(opts.resource)
    const force = Boolean(opts.force) && me.kind === 'human'
    const { rows } = await q.query<LockRow>(
      'delete from lp.locks where resource = $1 and (holder = $2 or $3) returning *',
      [resource, actor, force],
    )
    if (rows[0]) {
      await logEvent(q, {
        actor,
        kind: 'lock.released',
        summary: rows[0].holder === actor ? `${me.display_name} returned ${resource}` : `${me.display_name} took back ${resource} from ${await name(q, rows[0].holder)}`,
        entity_type: 'lock',
        entity_id: resource,
      })
    }
    return { released: Boolean(rows[0]) }
  }, actor)
}

export async function listLocks(q: Queryable): Promise<(LockRow & { expired: boolean })[]> {
  const { rows } = await q.query<LockRow & { expired: boolean }>('select *, lease_expires_at < now() as expired from lp.locks order by acquired_at desc')
  return rows
}

// ---------------------------------------------------------------- approvals

export interface ApprovalRow {
  id: number
  action: string
  summary: string
  payload: unknown
  est_cost_usd: number | null
  status: string
  requested_by: string
  decided_by: string | null
  decision_note: string | null
  task_id: number | null
  created_at: Date
  decided_at: Date | null
  expires_at: Date | null
  /** Set when the approval holds a queued Instantly change (migration 0009). */
  instantly_action_id?: number | null
}

export async function requestApproval(
  db: Db,
  actor: string,
  opts: { action: 'send' | 'spend' | 'destructive' | 'other'; summary: string; payload?: unknown; est_cost_usd?: number | null; task_id?: number | null; expires_in_hours?: number },
): Promise<ApprovalRow> {
  return db.tx(async (q) => {
    await requireActor(q, actor)
    if (!['send', 'spend', 'destructive', 'other'].includes(opts.action)) throw new OpsError('action must be send, spend, destructive or other')
    const summary = nonEmpty(opts.summary, 'summary', 1000)
    const hours = Number(opts.expires_in_hours)
    const { rows } = await q.query<ApprovalRow>(
      `insert into lp.approvals (action, summary, payload, est_cost_usd, requested_by, task_id, expires_at)
       values ($1, $2, $3, $4, $5, $6, case when $7::numeric > 0 then now() + make_interval(hours => $7::int) end) returning *`,
      [opts.action, summary, JSON.stringify(opts.payload ?? {}), opts.est_cost_usd ?? null, actor, opts.task_id ?? null, Number.isFinite(hours) ? hours : null],
    )
    if (opts.task_id) await q.query("update lp.tasks set status = 'needs_approval' where id = $1 and status in ('claimed', 'running')", [opts.task_id])
    const who = await name(q, actor)
    await logEvent(q, { actor, kind: 'approval.requested', summary: `${who} is asking to ${opts.action}: ${summary.slice(0, 200)}`, entity_type: 'approval', entity_id: rows[0].id, task_id: opts.task_id ?? null })
    const humans = await q.query<{ id: string }>("select id from lp.actors where kind = 'human' and active")
    for (const h of humans.rows) await notify(q, { recipient: h.id, kind: 'approval', summary: `${who} needs your OK to ${opts.action}: ${summary.slice(0, 200)}`, task_id: opts.task_id ?? null, created_by: actor })
    return rows[0]
  }, actor)
}

export async function decideApproval(db: Db, actor: string, id: number, decision: 'approved' | 'rejected', note?: string): Promise<ApprovalRow> {
  return db.tx(async (q) => {
    const me = await requireActor(q, actor)
    if (me.kind !== 'human') throw new OpsError('only a human can approve or reject', 403)
    const cur = await q.query<ApprovalRow>('select * from lp.approvals where id = $1 for update', [id])
    const a = cur.rows[0]
    if (!a) throw new OpsError(`approval ${id} not found`, 404)
    if (a.requested_by === actor) throw new OpsError('you cannot decide your own request', 403)
    if (a.status !== 'pending') throw new OpsError(`approval ${id} is already ${a.status}`, 409)
    if (a.instantly_action_id) {
      throw new OpsError('This is an Instantly change: decide it with its own Approve / Reject (lib/instantly/gate.ts), which runs or records it.', 409)
    }
    if (a.expires_at && a.expires_at.getTime() < Date.now()) {
      await q.query("update lp.approvals set status = 'expired' where id = $1", [id])
      throw new OpsError(`approval ${id} expired`, 409)
    }
    const { rows } = await q.query<ApprovalRow>(
      'update lp.approvals set status = $2, decided_by = $3, decision_note = $4, decided_at = now() where id = $1 returning *',
      [id, decision, actor, note?.slice(0, 2000) ?? null],
    )
    if (a.task_id) await q.query("update lp.tasks set status = 'running' where id = $1 and status = 'needs_approval'", [a.task_id])
    await logEvent(q, { actor, kind: `approval.${decision}`, summary: `${me.display_name} ${decision} ${await name(q, a.requested_by)}'s request to ${a.action}: ${a.summary.slice(0, 160)}`, entity_type: 'approval', entity_id: id, task_id: a.task_id })
    await notify(q, { recipient: a.requested_by, kind: 'approval', summary: `${me.display_name} ${decision} your request: ${a.summary.slice(0, 160)}`, task_id: a.task_id, created_by: actor })
    return rows[0]
  }, actor)
}

export async function getApproval(q: Queryable, id: number): Promise<ApprovalRow | null> {
  const { rows } = await q.query<ApprovalRow>(
    `update lp.approvals set status = 'expired' where id = $1 and status = 'pending' and expires_at < now() returning *`,
    [id],
  )
  if (rows[0]) return rows[0]
  const r = await q.query<ApprovalRow>('select * from lp.approvals where id = $1', [id])
  return r.rows[0] ?? null
}

// ---------------------------------------------------------------- memory

export interface MemoryRow {
  id: number
  scope: string
  key: string
  notes: string
  source: string | null
  updated_by: string | null
  created_at: Date
  updated_at: Date
}

async function canWriteScope(q: Queryable, actor: string, scope: string): Promise<boolean> {
  const me = await requireActor(q, actor)
  return me.kind === 'human' || scope === actor || scope === 'shared'
}

export async function memoryPut(db: Db, actor: string, m: { scope?: string; key: string; notes: string; source?: string | null }): Promise<MemoryRow> {
  return db.tx(async (q) => {
    const scope = (m.scope || actor).trim()
    if (!(await canWriteScope(q, actor, scope))) throw new OpsError(`${actor} may write only its own memory or 'shared'`, 403)
    if (scope !== 'shared' && !(await getActor(q, scope))) throw new OpsError(`unknown scope '${scope}'`)
    const key = nonEmpty(m.key, 'key', 200)
    const notes = nonEmpty(m.notes, 'notes', 20000)
    const { rows } = await q.query<MemoryRow>(
      `insert into lp.agent_memory (scope, key, notes, source, updated_by) values ($1, $2, $3, $4, $5)
       on conflict (scope, key) do update set notes = excluded.notes, source = excluded.source, updated_by = excluded.updated_by
       returning *`,
      [scope, key, notes, m.source?.slice(0, 1000) ?? null, actor],
    )
    await logEvent(q, { actor, kind: 'memory.put', summary: `${await name(q, actor)} saved a note "${key}" in ${scope === 'shared' ? 'shared memory' : `${await name(q, scope)}'s memory`}`, entity_type: 'memory', entity_id: rows[0].id })
    await touchActor(q, actor)
    return rows[0]
  }, actor)
}

export async function memoryDelete(db: Db, actor: string, m: { scope: string; key: string }): Promise<{ deleted: boolean }> {
  return db.tx(async (q) => {
    if (!(await canWriteScope(q, actor, m.scope))) throw new OpsError(`${actor} may delete only its own memory or 'shared'`, 403)
    const { rows } = await q.query<{ id: number }>('delete from lp.agent_memory where scope = $1 and key = $2 returning id', [m.scope, m.key])
    if (rows[0]) await logEvent(q, { actor, kind: 'memory.deleted', summary: `${await name(q, actor)} deleted the note "${m.key}" from ${m.scope}`, entity_type: 'memory', entity_id: rows[0].id })
    return { deleted: Boolean(rows[0]) }
  }, actor)
}

export async function memoryGet(q: Queryable, scope: string, key: string): Promise<MemoryRow | null> {
  const { rows } = await q.query<MemoryRow>('select * from lp.agent_memory where scope = $1 and key = $2', [scope, key])
  return rows[0] ?? null
}

/** Search an actor's own memory plus shared notes (or one scope). */
export async function memorySearch(q: Queryable, opts: { scopes: string[]; query?: string; limit?: number }): Promise<MemoryRow[]> {
  const term = opts.query?.trim() ? `%${opts.query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null
  const { rows } = await q.query<MemoryRow>(
    `select * from lp.agent_memory where scope = any($1)
       and ($2::text is null or key ilike $2 or notes ilike $2)
     order by updated_at desc limit $3`,
    [opts.scopes, term, Math.min(Math.max(Number(opts.limit) || 50, 1), 500)],
  )
  return rows
}

// ---------------------------------------------------------------- inbox & events

export async function inbox(q: Queryable, actor: string, opts: { unread_only?: boolean; limit?: number } = {}) {
  const { rows } = await q.query(
    `select * from lp.notifications where recipient = $1 and ($2::boolean is not true or read_at is null)
     order by created_at desc limit $3`,
    [actor, opts.unread_only ?? true, Math.min(Math.max(Number(opts.limit) || 50, 1), 200)],
  )
  return rows
}

export async function markRead(q: Queryable, actor: string, ids?: number[]): Promise<number> {
  const r = await q.query(
    'update lp.notifications set read_at = now() where recipient = $1 and read_at is null and ($2::bigint[] is null or id = any($2)) returning id',
    [actor, ids && ids.length ? ids : null],
  )
  return r.rows.length
}

export async function recentEvents(q: Queryable, opts: { limit?: number; actor?: string | null; since_id?: number | null; kind_prefix?: string | null } = {}) {
  const { rows } = await q.query(
    `select e.*, a.display_name as actor_name, a.kind as actor_kind from lp.events e left join lp.actors a on a.id = e.actor
      where ($1::text is null or e.actor = $1)
        and ($2::bigint is null or e.id > $2)
        and ($3::text is null or e.kind like $3 || '%')
      order by e.id desc limit $4`,
    [opts.actor ?? null, opts.since_id ?? null, opts.kind_prefix ?? null, Math.min(Math.max(Number(opts.limit) || 100, 1), 500)],
  )
  return rows
}
