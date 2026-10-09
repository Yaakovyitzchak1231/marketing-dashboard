/**
 * One table of operations, two doors:
 *  - agents call them over HTTP (POST /api/ops with {op, ...args}, or the REST
 *    aliases), authenticated by their own bearer token;
 *  - the dashboard calls the same functions as the signed-in human ('owner').
 *
 * GET /api/ops lists every op with its arguments, so an agent (or an MCP
 * wrapper) can discover the contract.
 */
import type { Db } from '../db/types.ts'
import {
  OpsError,
  acquireLock,
  claimTask,
  comment,
  completeTask,
  createTask,
  failTask,
  getApproval,
  handoffTask,
  heartbeatTask,
  inbox,
  listLocks,
  markRead,
  memoryDelete,
  memoryGet,
  memoryPut,
  memorySearch,
  recentEvents,
  releaseLock,
  requestApproval,
  sendMessage,
  touchActor,
  updateTask,
} from './core.ts'
import { logEvent } from './events.ts'
import { ackDeliveries, dispatchDue, feed } from '../notify/deliver.ts'

// The Instantly gate and its read-only lookups are server-only modules; they
// load on first use so this table stays importable anywhere.
const gate = () => import('../instantly/gate.ts')
const lookups = () => import('../instantly/lookup.ts')
import { applyResearchResult } from '../research/apply.ts'
import type { ResearchResult } from '../research/types.ts'
import { CAMPAIGN_OPS, campaignRoute } from '../campaigns/ops.ts'
import { getRuleSet, listProposals, listRuleSets, proposeRuleChange, ruleSetForCampaign } from '../rules/store.ts'
import { leadReadiness } from '../rules/readiness.ts'
import { recomputeStatus, runRecompute, tierCounts } from '../rules/recompute.ts'
import { FIELD_CATALOG, OPS as RULE_OPS } from '../rules/schema.ts'
import { STANDING_RULES } from '../rules/standing.ts'
import { setOwnerResearchExhausted } from '../rules/owner-research.ts'
import { RulesError } from '../rules/schema.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function id(v: unknown, field = 'task_id'): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new OpsError(`${field} must be a positive integer`)
  return n
}
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/**
 * Default-deny for Instantly: a generic approval that talks about Instantly is
 * refused, because approving it would not run anything here and the agent
 * would have to make the change itself. Instantly changes go through the
 * instantly_* ops, which the dashboard runs only after a human approves.
 */
export function mentionsInstantly(...parts: unknown[]): boolean {
  return parts.some((p) => {
    if (p == null) return false
    const s = typeof p === 'string' ? p : JSON.stringify(p)
    return /instantly/i.test(s ?? '')
  })
}

const INSTANTLY_ONLY_THROUGH_GATE =
  'Instantly changes are not approved this way. Use instantly_add_leads, instantly_pause_campaign or instantly_resume_campaign: they queue the change with a preview in "Needs your OK" and the dashboard runs it only after a human approves. Any other Instantly change (sequences, settings, deleting) is done by a human in Instantly.'

function requireReason(a: Args): string {
  const r = typeof a.reason === 'string' ? a.reason.trim() : ''
  if (!r) throw new OpsError('reason is required: one plain sentence the human reads before approving')
  return r
}

export const OPS: Record<string, Op> = {
  whoami: {
    args: '{}',
    run: async (db, actor) => {
      await touchActor(db, actor)
      const { rows } = await db.query('select id, kind, display_name, harness, can_send from lp.actors where id = $1', [actor])
      return rows[0] ?? null
    },
  },
  presence: {
    args: '{status_note?: string}  -- "what I am doing now", shown on the Agents screen',
    run: async (db, actor, a) => {
      await touchActor(db, actor, str(a.status_note) ?? null)
      return { ok: true }
    },
  },
  create_task: {
    args: '{title, kind?, body?, assigned_to?, project_id?, company_id?, payload?, priority?, dedupe_key?}',
    run: (db, actor, a) =>
      createTask(db, actor, {
        title: String(a.title ?? ''),
        kind: str(a.kind),
        body: str(a.body),
        assigned_to: str(a.assigned_to) ?? null,
        project_id: a.project_id == null ? null : id(a.project_id, 'project_id'),
        company_id: a.company_id == null ? null : id(a.company_id, 'company_id'),
        payload: (a.payload as Record<string, unknown>) ?? {},
        priority: a.priority == null ? undefined : Number(a.priority),
        dedupe_key: str(a.dedupe_key) ?? null,
      }),
  },
  list_tasks: {
    args: '{status?: string[], assigned_to?: string, kind?: string, limit?}',
    run: async (db, _actor, a) => {
      const statuses = Array.isArray(a.status) ? a.status.map(String) : a.status ? [String(a.status)] : null
      const { rows } = await db.query(
        `select * from lp.tasks where ($1::text[] is null or status = any($1)) and ($2::text is null or assigned_to = $2)
           and ($3::text is null or kind = $3) order by priority desc, id desc limit $4`,
        [statuses, str(a.assigned_to) ?? null, str(a.kind) ?? null, Math.min(Number(a.limit) || 50, 200)],
      )
      return rows
    },
  },
  get_task: {
    args: '{task_id}',
    run: async (db, _actor, a) => {
      const tid = id(a.task_id)
      const t = await db.query('select * from lp.tasks where id = $1', [tid])
      if (!t.rows[0]) throw new OpsError(`task ${tid} not found`, 404)
      const c = await db.query('select id, author, kind, body, mentions, created_at from lp.comments where task_id = $1 order by id', [tid])
      return { ...t.rows[0], comments: c.rows }
    },
  },
  claim_task: {
    args: '{kinds?: string[], task_id?, lease_seconds? (default 300, max 3600)}  -> the task, or null when nothing is waiting',
    run: (db, actor, a) =>
      claimTask(db, actor, {
        kinds: Array.isArray(a.kinds) ? a.kinds.map(String) : undefined,
        task_id: a.task_id == null ? undefined : id(a.task_id),
        lease_seconds: a.lease_seconds == null ? undefined : Number(a.lease_seconds),
      }),
  },
  heartbeat: {
    args: '{task_id, lease_seconds?, progress?: object, status_note?}  -- call at least every lease_seconds/2',
    run: (db, actor, a) =>
      heartbeatTask(db, actor, id(a.task_id), {
        lease_seconds: a.lease_seconds == null ? undefined : Number(a.lease_seconds),
        progress: a.progress,
        status_note: str(a.status_note),
      }),
  },
  complete_task: {
    args: '{task_id, result?: object, report?: string}  -- for research_company, put a ResearchResult at result.research and it is written to the lead (evidence required)',
    run: async (db, actor, a) => {
      const tid = id(a.task_id)
      const result = a.result as Record<string, unknown> | undefined
      const research = result && typeof result === 'object' ? (result.research as ResearchResult | undefined) : undefined
      let applied: unknown = undefined
      if (research && typeof research === 'object') {
        const t = await db.query<{ kind: string; company_id: number | null; claimed_by: string | null; status: string }>(
          'select kind, company_id, claimed_by, status from lp.tasks where id = $1',
          [tid],
        )
        const task = t.rows[0]
        if (!task) throw new OpsError(`task ${tid} not found`, 404)
        if (task.claimed_by !== actor || !['claimed', 'running', 'blocked'].includes(task.status)) {
          throw new OpsError(`task ${tid} is not claimed by ${actor}`, 409)
        }
        if (task.kind !== 'research_company' || !task.company_id) throw new OpsError('result.research is only accepted on a research_company task')
        if (Number(research.company_id) !== task.company_id) throw new OpsError(`result.research.company_id must be ${task.company_id}`)
        const clean: ResearchResult = {
          company_id: task.company_id,
          runner: typeof research.runner === 'string' && research.runner ? research.runner.slice(0, 40) : actor,
          pages_fetched: Array.isArray(research.pages_fetched) ? research.pages_fetched : [],
          emails: Array.isArray(research.emails) ? research.emails : [],
          people: Array.isArray(research.people) ? research.people : [],
          phones: Array.isArray(research.phones) ? research.phones : [],
          facts: Array.isArray(research.facts) ? research.facts : [],
          summary: typeof research.summary === 'string' ? research.summary : `${actor} researched the company`,
        }
        applied = await applyResearchResult(db, clean, actor, { task_id: tid })
      }
      const done = await completeTask(db, actor, tid, { result: applied === undefined ? a.result : { ...result, applied }, report: str(a.report) })
      return applied === undefined ? done : { ...done, applied }
    },
  },
  fail_task: {
    args: '{task_id, error, retry? (default true while attempts remain)}',
    run: (db, actor, a) => failTask(db, actor, id(a.task_id), { error: String(a.error ?? ''), retry: a.retry === undefined ? undefined : Boolean(a.retry) }),
  },
  handoff_task: {
    args: '{task_id, to: actor id, note}',
    run: (db, actor, a) => handoffTask(db, actor, id(a.task_id), { to: String(a.to ?? ''), note: String(a.note ?? '') }),
  },
  update_task: {
    args: '{task_id, status?: queued|blocked|cancelled|done, assigned_to?, priority?, title?}',
    run: (db, actor, a) => {
      const patch: Parameters<typeof updateTask>[3] = {}
      if (a.status !== undefined) patch.status = String(a.status) as 'queued'
      if ('assigned_to' in a) patch.assigned_to = (str(a.assigned_to) || null) as string | null
      if (a.priority !== undefined) patch.priority = Number(a.priority)
      if (a.title !== undefined) patch.title = String(a.title)
      return updateTask(db, actor, id(a.task_id), patch)
    },
  },
  comment: {
    args: '{task_id? | company_id?, body}  -- @tab, @hermes, @owner mention a teammate',
    run: (db, actor, a) =>
      comment(db, actor, {
        task_id: a.task_id == null ? null : id(a.task_id),
        company_id: a.company_id == null ? null : id(a.company_id, 'company_id'),
        body: String(a.body ?? ''),
      }),
  },
  acquire_lock: {
    args: "{resource: 'campaign:<id>'|'company:<id>'|'list:<name>', lease_seconds?, note?, task_id?}  -> {ok:true, lock} | {ok:false, held_by}",
    run: (db, actor, a) =>
      acquireLock(db, actor, {
        resource: String(a.resource ?? ''),
        lease_seconds: a.lease_seconds == null ? undefined : Number(a.lease_seconds),
        note: str(a.note),
        task_id: a.task_id == null ? null : id(a.task_id),
      }),
  },
  release_lock: {
    args: '{resource}',
    run: (db, actor, a) => releaseLock(db, actor, { resource: String(a.resource ?? '') }),
  },
  list_locks: { args: '{}', run: (db) => listLocks(db) },
  log_event: {
    args: '{kind, summary (plain English), entity_type?, entity_id?, task_id?, data?}',
    run: async (db, actor, a) => {
      const kind = String(a.kind ?? '').trim()
      const summary = String(a.summary ?? '').trim()
      if (!kind || !summary) throw new OpsError('kind and summary are required')
      await touchActor(db, actor)
      return {
        id: await logEvent(db, {
          actor,
          kind: kind.slice(0, 80),
          summary,
          entity_type: str(a.entity_type) ?? null,
          entity_id: (a.entity_id as string | number | null) ?? null,
          task_id: a.task_id == null ? null : id(a.task_id),
          data: a.data,
        }),
      }
    },
  },
  request_approval: {
    args: '{action: send|spend|destructive|other, summary, payload?, est_cost_usd?, task_id?, expires_in_hours?}  -> poll get_approval until approved/rejected. Not for Instantly changes (use the instantly_* ops).',
    run: (db, actor, a) => {
      if (mentionsInstantly(a.summary, a.payload)) throw new OpsError(INSTANTLY_ONLY_THROUGH_GATE, 409)
      return requestApproval(db, actor, {
        action: String(a.action ?? '') as 'send',
        summary: String(a.summary ?? ''),
        payload: a.payload,
        est_cost_usd: a.est_cost_usd == null ? null : Number(a.est_cost_usd),
        task_id: a.task_id == null ? null : id(a.task_id),
        expires_in_hours: a.expires_in_hours == null ? undefined : Number(a.expires_in_hours),
      })
    },
  },
  instantly_add_leads: {
    args: '{campaign_id, campaign_name?, company_ids?: number[], emails?: string[], batch?: "standard"|"role-inbox" (default standard; role-inbox = only role inboxes released after owner research came up empty), reason, task_id?, expires_in_hours? (default 72)}  -> NEVER sends: queues the change with a preview in "Needs your OK"; a human approves (the dashboard then adds them) or rejects with a reason. Poll get_approval / get_instantly_action.',
    run: async (db, actor, a) =>
      (await gate()).requestAddLeads(
        db,
        actor,
        {
          campaign_id: a.campaign_id,
          campaign_name: a.campaign_name,
          company_ids: a.company_ids,
          emails: a.emails,
          batch: a.batch,
          reason: requireReason(a),
          task_id: a.task_id == null ? null : id(a.task_id),
          expires_in_hours: a.expires_in_hours == null ? undefined : Number(a.expires_in_hours),
        },
        (await lookups()).instantlyLookupFromEnv(),
      ),
  },
  instantly_pause_campaign: {
    args: '{campaign_id, campaign_name?, reason, task_id?, expires_in_hours?}  -> NEVER pauses directly: queues it for a human OK',
    run: async (db, actor, a) => {
      const reason = requireReason(a)
      const cid = typeof a.campaign_id === 'string' ? a.campaign_id.trim() : ''
      return (await gate()).requestCampaignSwitch(db, actor, {
        kind: 'pause',
        campaign_id: a.campaign_id,
        campaign_name: a.campaign_name,
        reason,
        current_status: cid ? await (await lookups()).campaignStatusFromEnv(cid) : null,
        task_id: a.task_id == null ? null : id(a.task_id),
        expires_in_hours: a.expires_in_hours == null ? undefined : Number(a.expires_in_hours),
      })
    },
  },
  instantly_resume_campaign: {
    args: '{campaign_id, campaign_name?, reason, task_id?, expires_in_hours?}  -> NEVER resumes directly: queues it for a human OK',
    run: async (db, actor, a) => {
      const reason = requireReason(a)
      const cid = typeof a.campaign_id === 'string' ? a.campaign_id.trim() : ''
      return (await gate()).requestCampaignSwitch(db, actor, {
        kind: 'resume',
        campaign_id: a.campaign_id,
        campaign_name: a.campaign_name,
        reason,
        current_status: cid ? await (await lookups()).campaignStatusFromEnv(cid) : null,
        task_id: a.task_id == null ? null : id(a.task_id),
        expires_in_hours: a.expires_in_hours == null ? undefined : Number(a.expires_in_hours),
      })
    },
  },
  get_instantly_action: {
    args: '{action_id}  -> a queued Instantly change: awaiting_approval | approved | rejected (decision_note says why) | sending | done | failed | unknown | cancelled',
    run: async (db, _actor, a) => (await gate()).getInstantlyAction(db, id(a.action_id, 'action_id')),
  },
  get_approval: {
    args: '{approval_id}',
    run: async (db, _actor, a) => {
      const r = await getApproval(db, id(a.approval_id, 'approval_id'))
      if (!r) throw new OpsError('approval not found', 404)
      return r
    },
  },
  memory_get: {
    args: "{key, scope? (default: your own; 'shared' for team notes)}",
    run: (db, actor, a) => memoryGet(db, str(a.scope) || actor, String(a.key ?? '')),
  },
  memory_put: {
    args: "{key, notes, source?, scope? (your own id or 'shared')}",
    run: (db, actor, a) => memoryPut(db, actor, { scope: str(a.scope), key: String(a.key ?? ''), notes: String(a.notes ?? ''), source: str(a.source) ?? null }),
  },
  memory_search: {
    args: '{query?, limit?}  -- searches your own memory plus shared',
    run: (db, actor, a) => memorySearch(db, { scopes: [actor, 'shared'], query: str(a.query), limit: a.limit == null ? undefined : Number(a.limit) }),
  },
  memory_delete: {
    args: "{key, scope? (your own id or 'shared')}",
    run: (db, actor, a) => memoryDelete(db, actor, { scope: str(a.scope) || actor, key: String(a.key ?? '') }),
  },
  inbox: {
    args: '{unread_only? (default true), limit?}  -- your @mentions, assignments, handoffs, approval answers',
    run: async (db, actor, a) => {
      await touchActor(db, actor)
      return inbox(db, actor, { unread_only: a.unread_only === undefined ? true : Boolean(a.unread_only), limit: a.limit == null ? undefined : Number(a.limit) })
    },
  },
  send_message: {
    args: '{to: actor id, body, task_id?}  -- a direct message to a person or agent; it goes out on their channels at once',
    run: (db, actor, a) => sendMessage(db, actor, { to: String(a.to ?? ''), body: String(a.body ?? ''), task_id: a.task_id == null ? null : id(a.task_id) }),
  },
  feed: {
    args: '{after_id?, limit?}  -- your new events (assignments, handoffs, mentions, messages, relay jobs). Ack each with feed_ack; unacked ones come back after 2 min',
    run: async (db, actor, a) => {
      await touchActor(db, actor)
      const items = await feed(db, actor, { after_id: a.after_id == null ? null : Number(a.after_id), limit: a.limit == null ? undefined : Number(a.limit) })
      // Reading the feed also pushes anything due (retries need no cron).
      await dispatchDue(db).catch(() => undefined)
      return items
    },
  },
  feed_ack: {
    args: '{ids: delivery_id[]}  -- "got it": marks those events delivered',
    run: async (db, actor, a) => ackDeliveries(db, actor, Array.isArray(a.ids) ? a.ids.map((x) => id(x, 'ids')) : []),
  },
  mark_read: {
    args: '{ids?: number[]}  -- omit to mark all read',
    run: async (db, actor, a) => ({ marked: await markRead(db, actor, Array.isArray(a.ids) ? a.ids.map((x) => id(x, 'ids')) : undefined) }),
  },
  list_rule_sets: {
    args: '{}  -- every lead rule set (default, pools, campaigns, templates) with counts; read-only',
    run: async (db) => {
      const [sets, counts, jobs] = await Promise.all([listRuleSets(db), tierCounts(db), recomputeStatus(db)])
      return {
        rule_sets: sets.map((s) => ({ ...s, counts: counts.get(s.id) ?? null, rescore: jobs.get(s.id) ?? null })),
        standing_rules: STANDING_RULES,
        fields: FIELD_CATALOG,
        conditions: RULE_OPS,
      }
    },
  },
  get_rule_set: {
    args: '{rule_set_id?: number, campaign_id?: string}  -- one rule set, or the one an Instantly campaign uses now; read-only',
    run: async (db, _actor, a) => {
      const rs = a.rule_set_id != null ? await getRuleSet(db, id(a.rule_set_id, 'rule_set_id')) : await ruleSetForCampaign(db, str(a.campaign_id) ?? null)
      if (!rs) throw new OpsError('rule set not found', 404)
      return { ...rs, proposals: await listProposals(db, rs.id) }
    },
  },
  lead_readiness: {
    args: '{company_id}  -- Ready-personalized / Ready-generic / Parked (with reasons) under every rule set for the lead\'s pool',
    run: async (db, _actor, a) => {
      const out = await leadReadiness(db, id(a.company_id, 'company_id'))
      return out.map((r) => ({ rule_set: { id: r.ruleSet.id, name: r.ruleSet.name, scope: r.ruleSet.scope, campaign_id: r.ruleSet.campaign_id, version: r.ruleSet.version }, verdict: r.verdict }))
    },
  },
  propose_rule_change: {
    args: '{rule_set_id, name, requirements: [...], fields: [...], note?}  -- agents cannot change rules; this puts the change in Needs your OK and a person applies it on /rules/:id',
    run: (db, actor, a) => proposeRuleChange(db, actor, a),
  },
  mark_owner_research_exhausted: {
    args: '{company_id, exhausted?: boolean (default true), note?}  -- the owner\'s own email can\'t be found; releases the store\'s role inbox to role-inbox batches (still only a human sends)',
    run: async (db, actor, a) => {
      try {
        return await setOwnerResearchExhausted(db, actor, id(a.company_id, 'company_id'), a.exhausted === undefined ? true : a.exhausted === true || a.exhausted === 'true', str(a.note) ?? null)
      } catch (e) {
        if (e instanceof RulesError) throw new OpsError(e.message, e.status)
        throw e
      }
    },
  },
  rules_recompute: {
    args: '{budget_ms?: number}  -- run one re-scoring pass (max 25 s); changes no rules',
    run: (db, _actor, a) => runRecompute(db, { budgetMs: Math.min(25_000, Math.max(1_000, Number(a.budget_ms) || 10_000)) }),
  },
  recent_events: {
    args: '{limit?, since_id?, actor?, kind_prefix?}',
    run: (db, _actor, a) =>
      recentEvents(db, {
        limit: a.limit == null ? undefined : Number(a.limit),
        since_id: a.since_id == null ? null : Number(a.since_id),
        actor: str(a.actor) ?? null,
        kind_prefix: str(a.kind_prefix) ?? null,
      }),
  },
  // Campaigns workspace (lib/campaigns/ops.ts): create/edit/duplicate/archive campaigns, build lead lists.
  ...CAMPAIGN_OPS,
}

export async function runOp(db: Db, actor: string, op: string, args: Args): Promise<unknown> {
  const o = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : undefined
  if (!o) throw new OpsError(`unknown op '${op}'. GET /api/ops lists them.`, 404)
  return o.run(db, actor, args ?? {})
}

/** REST aliases: /api/ops/tasks/claim, /api/ops/tasks/12/heartbeat, ... -> op + args. */
export function routeToOp(method: string, path: string[]): { op: string; args: Args } | null {
  const [a, b, c] = path
  if (method === 'POST' && a === 'tasks' && b === 'claim' && !c) return { op: 'claim_task', args: {} }
  if (method === 'POST' && a === 'tasks' && !b) return { op: 'create_task', args: {} }
  if (method === 'GET' && a === 'tasks' && !b) return { op: 'list_tasks', args: {} }
  if (a === 'tasks' && b && /^\d+$/.test(b)) {
    const map: Record<string, string> = { heartbeat: 'heartbeat', complete: 'complete_task', fail: 'fail_task', handoff: 'handoff_task', comment: 'comment', update: 'update_task' }
    if (method === 'GET' && !c) return { op: 'get_task', args: { task_id: Number(b) } }
    if (method === 'POST' && c && map[c]) return { op: map[c], args: { task_id: Number(b) } }
  }
  if (a === 'locks') {
    if (method === 'GET' && !b) return { op: 'list_locks', args: {} }
    if (method === 'POST' && b === 'acquire') return { op: 'acquire_lock', args: {} }
    if (method === 'POST' && b === 'release') return { op: 'release_lock', args: {} }
  }
  if (method === 'POST' && a === 'events' && !b) return { op: 'log_event', args: {} }
  if (method === 'GET' && a === 'events' && !b) return { op: 'recent_events', args: {} }
  if (a === 'instantly') {
    if (method === 'POST' && b === 'add-leads' && !c) return { op: 'instantly_add_leads', args: {} }
    if (method === 'POST' && b === 'pause' && !c) return { op: 'instantly_pause_campaign', args: {} }
    if (method === 'POST' && b === 'resume' && !c) return { op: 'instantly_resume_campaign', args: {} }
    if (method === 'GET' && b === 'actions' && c && /^\d+$/.test(c)) return { op: 'get_instantly_action', args: { action_id: Number(c) } }
  }
  if (a === 'approvals') {
    if (method === 'POST' && !b) return { op: 'request_approval', args: {} }
    if (method === 'GET' && b && /^\d+$/.test(b)) return { op: 'get_approval', args: { approval_id: Number(b) } }
  }
  if (a === 'memory') {
    if (method === 'GET' && !b) return { op: 'memory_search', args: {} }
    if (method === 'POST' && !b) return { op: 'memory_put', args: {} }
    if (method === 'GET' && b) return { op: 'memory_get', args: { key: decodeURIComponent(b) } }
  }
  if (method === 'GET' && a === 'inbox' && !b) return { op: 'inbox', args: {} }
  if (method === 'GET' && a === 'feed' && !b) return { op: 'feed', args: {} }
  if (method === 'POST' && a === 'feed' && b === 'ack' && !c) return { op: 'feed_ack', args: {} }
  if (method === 'POST' && a === 'messages' && !b) return { op: 'send_message', args: {} }
  if (method === 'POST' && a === 'inbox' && b === 'read') return { op: 'mark_read', args: {} }
  if (method === 'POST' && a === 'presence') return { op: 'presence', args: {} }
  if (method === 'GET' && a === 'whoami') return { op: 'whoami', args: {} }
  if (a === 'campaigns') return campaignRoute(method, path)
  if (a === 'rules') {
    if (method === 'GET' && !b) return { op: 'list_rule_sets', args: {} }
    if (method === 'POST' && b === 'recompute' && !c) return { op: 'rules_recompute', args: {} }
    if (method === 'GET' && b && /^\d+$/.test(b) && !c) return { op: 'get_rule_set', args: { rule_set_id: Number(b) } }
    if (method === 'POST' && b && /^\d+$/.test(b) && c === 'propose') return { op: 'propose_rule_change', args: { rule_set_id: Number(b) } }
  }
  if (method === 'GET' && a === 'leads' && b && /^\d+$/.test(b) && c === 'readiness') return { op: 'lead_readiness', args: { company_id: Number(b) } }
  if (method === 'POST' && a === 'leads' && b && /^\d+$/.test(b) && c === 'owner-research-exhausted') return { op: 'mark_owner_research_exhausted', args: { company_id: Number(b) } }
  return null
}
