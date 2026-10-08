import type { Queryable } from '../db/types.ts'

export interface ActorView {
  id: string
  kind: 'human' | 'agent'
  display_name: string
  harness: string | null
  status_note: string | null
  last_seen_at: Date | null
  active_tasks: number
  queued_for: number
  locks_held: number
  unread: number
  memory_notes: number
}

export async function listActors(q: Queryable): Promise<ActorView[]> {
  const { rows } = await q.query<ActorView>(
    `select a.id, a.kind, a.display_name, a.harness, a.status_note, a.last_seen_at,
            (select count(*)::int from lp.tasks t where t.claimed_by = a.id and t.status in ('claimed', 'running', 'blocked', 'needs_approval')) as active_tasks,
            (select count(*)::int from lp.tasks t where t.assigned_to = a.id and t.status = 'queued') as queued_for,
            (select count(*)::int from lp.locks l where l.holder = a.id and l.lease_expires_at > now()) as locks_held,
            (select count(*)::int from lp.notifications n where n.recipient = a.id and n.read_at is null) as unread,
            (select count(*)::int from lp.agent_memory m where m.scope = a.id) as memory_notes
       from lp.actors a where a.active
      order by a.kind desc, a.last_seen_at desc nulls last, a.display_name`,
  )
  return rows
}

export interface BoardTask {
  id: number
  title: string
  kind: string
  status: string
  priority: number
  assigned_to: string | null
  assigned_name: string | null
  claimed_by: string | null
  claimed_name: string | null
  lease_expires_at: Date | null
  heartbeat_at: Date | null
  project_id: number | null
  project_name: string | null
  company_id: number | null
  company_name: string | null
  comments: number
  progress: unknown
  report: string | null
  error: string | null
  created_by: string | null
  created_at: Date
  updated_at: Date
  finished_at: Date | null
}

const TASK_SELECT = `
  select t.id, t.title, t.kind, t.status, t.priority, t.assigned_to, aa.display_name as assigned_name,
         t.claimed_by, ca.display_name as claimed_name, t.lease_expires_at, t.heartbeat_at,
         t.project_id, p.name as project_name, t.company_id, co.name as company_name,
         (select count(*)::int from lp.comments c where c.task_id = t.id) as comments,
         case when jsonb_typeof(t.result) = 'object' then t.result -> 'progress' end as progress,
         t.report, t.error, t.created_by, t.created_at, t.updated_at, t.finished_at
    from lp.tasks t
    left join lp.actors aa on aa.id = t.assigned_to
    left join lp.actors ca on ca.id = t.claimed_by
    left join lp.projects p on p.id = t.project_id
    left join lp.companies co on co.id = t.company_id`

export async function boardTasks(
  q: Queryable,
  f: { project_id?: number | null; person?: string | null; kind?: string | null } = {},
): Promise<BoardTask[]> {
  const { rows } = await q.query<BoardTask>(
    `${TASK_SELECT}
      where ($1::bigint is null or t.project_id = $1)
        and ($2::text is null or t.assigned_to = $2 or t.claimed_by = $2 or t.created_by = $2)
        and ($3::text is null or t.kind = $3)
        and (t.status in ('queued', 'claimed', 'running', 'blocked', 'needs_approval') or t.finished_at > now() - interval '7 days')
      order by t.priority desc, t.updated_at desc
      limit 400`,
    [f.project_id ?? null, f.person ?? null, f.kind ?? null],
  )
  return rows
}

export async function getTaskDetail(q: Queryable, id: number) {
  const t = await q.query<BoardTask & { payload: unknown; result: unknown; handoff_note: string | null; attempts: number; max_attempts: number; dedupe_key: string | null }>(
    TASK_SELECT.replace('t.report, t.error,', 't.report, t.error, t.payload, t.result, t.handoff_note, t.attempts, t.max_attempts, t.dedupe_key,') + ' where t.id = $1',
    [id],
  )
  if (!t.rows[0]) return null
  const comments = await q.query<{ id: number; author: string; author_name: string; author_kind: string; kind: string; body: string; mentions: string[]; created_at: Date }>(
    `select c.id, c.author, a.display_name as author_name, a.kind as author_kind, c.kind, c.body, c.mentions, c.created_at
       from lp.comments c join lp.actors a on a.id = c.author where c.task_id = $1 order by c.id`,
    [id],
  )
  const events = await q.query<{ id: number; at: Date; summary: string; actor: string | null }>(
    'select id, at, summary, actor from lp.events where task_id = $1 order by id desc limit 50',
    [id],
  )
  const approvals = await q.query<{ id: number; action: string; summary: string; status: string; created_at: Date }>(
    'select id, action, summary, status, created_at from lp.approvals where task_id = $1 order by id desc',
    [id],
  )
  return { task: t.rows[0], comments: comments.rows, events: events.rows, approvals: approvals.rows }
}

export async function listProjects(q: Queryable) {
  const { rows } = await q.query<{ id: number; name: string; description: string | null; status: string; open_tasks: number }>(
    `select p.id, p.name, p.description, p.status,
            (select count(*)::int from lp.tasks t where t.project_id = p.id and t.status in ('queued', 'claimed', 'running', 'blocked', 'needs_approval')) as open_tasks
       from lp.projects p where p.status <> 'archived' order by p.name`,
  )
  return rows
}

export async function pendingApprovals(q: Queryable) {
  const { rows } = await q.query<{ id: number; action: string; summary: string; est_cost_usd: number | null; requested_by: string; requester_name: string; task_id: number | null; created_at: Date; expires_at: Date | null; payload: unknown }>(
    `select ap.id, ap.action, ap.summary, ap.est_cost_usd, ap.requested_by, a.display_name as requester_name, ap.task_id, ap.created_at, ap.expires_at, ap.payload
       from lp.approvals ap join lp.actors a on a.id = ap.requested_by
      where ap.status = 'pending' and (ap.expires_at is null or ap.expires_at > now())
      order by ap.created_at`,
  )
  return rows
}

export async function activeLocks(q: Queryable) {
  const { rows } = await q.query<{ resource: string; holder: string; holder_name: string; note: string | null; acquired_at: Date; lease_expires_at: Date; task_id: number | null }>(
    `select l.resource, l.holder, a.display_name as holder_name, l.note, l.acquired_at, l.lease_expires_at, l.task_id
       from lp.locks l join lp.actors a on a.id = l.holder where l.lease_expires_at > now() order by l.acquired_at desc`,
  )
  return rows
}

export interface FeedEvent {
  id: number
  at: Date
  actor: string | null
  actor_name: string | null
  actor_kind: string | null
  kind: string
  summary: string
  entity_type: string | null
  entity_id: string | null
  task_id: number | null
}

export async function feed(q: Queryable, f: { actor?: string | null; kind_prefix?: string | null; limit?: number; before_id?: number | null } = {}): Promise<FeedEvent[]> {
  const { rows } = await q.query<FeedEvent>(
    `select e.id, e.at, e.actor, a.display_name as actor_name, a.kind as actor_kind, e.kind, e.summary, e.entity_type, e.entity_id, e.task_id
       from lp.events e left join lp.actors a on a.id = e.actor
      where ($1::text is null or e.actor = $1) and ($2::text is null or e.kind like $2 || '%') and ($4::bigint is null or e.id < $4)
      order by e.id desc limit $3`,
    [f.actor ?? null, f.kind_prefix ?? null, Math.min(Math.max(f.limit ?? 100, 1), 500), f.before_id ?? null],
  )
  return rows
}

export async function actorDetail(q: Queryable, id: string) {
  const a = await q.query<{ id: string; kind: string; display_name: string; harness: string | null; status_note: string | null; last_seen_at: Date | null; can_send: boolean }>(
    'select id, kind, display_name, harness, status_note, last_seen_at, can_send from lp.actors where id = $1',
    [id],
  )
  if (!a.rows[0]) return null
  const current = await q.query<BoardTask>(`${TASK_SELECT} where t.claimed_by = $1 and t.status in ('claimed', 'running', 'blocked', 'needs_approval') order by t.updated_at desc`, [id])
  const queued = await q.query<BoardTask>(`${TASK_SELECT} where t.assigned_to = $1 and t.status = 'queued' order by t.priority desc, t.id`, [id])
  const reports = await q.query<BoardTask>(`${TASK_SELECT} where t.claimed_by = $1 and t.status in ('done', 'failed') order by t.finished_at desc nulls last limit 15`, [id])
  const memory = await q.query<{ id: number; key: string; notes: string; source: string | null; updated_by: string | null; updated_at: Date }>(
    'select id, key, notes, source, updated_by, updated_at from lp.agent_memory where scope = $1 order by updated_at desc limit 200',
    [id],
  )
  const notifications = await q.query<{ id: number; kind: string; summary: string; task_id: number | null; created_at: Date; read_at: Date | null }>(
    'select id, kind, summary, task_id, created_at, read_at from lp.notifications where recipient = $1 order by created_at desc limit 30',
    [id],
  )
  const locks = await q.query<{ resource: string; note: string | null; lease_expires_at: Date }>('select resource, note, lease_expires_at from lp.locks where holder = $1 and lease_expires_at > now()', [id])
  const events = await feed(q, { actor: id, limit: 30 })
  return { actor: a.rows[0], current: current.rows, queued: queued.rows, reports: reports.rows, memory: memory.rows, notifications: notifications.rows, locks: locks.rows, events }
}

export async function sharedMemory(q: Queryable) {
  const { rows } = await q.query<{ id: number; key: string; notes: string; source: string | null; updated_by: string | null; updated_at: Date }>(
    "select id, key, notes, source, updated_by, updated_at from lp.agent_memory where scope = 'shared' order by updated_at desc limit 200",
  )
  return rows
}
