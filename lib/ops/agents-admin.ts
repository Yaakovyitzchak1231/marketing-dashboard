import type { Db, Queryable } from '../db/types.ts'
import { logEvent } from './events.ts'
import { OpsError } from './core.ts'
import { requireOwnerActor } from './actor-role.ts'

/**
 * Owner-only agent administration from the dashboard (tracker 1.2):
 *   rename          lp.actors.display_name (trimmed, 1..80 characters)
 *   disable/enable  lp.actors.active. A disabled agent is refused by every ops
 *                   path that looks actors up with `and active` (lib/ops/core.ts
 *                   getActor, lib/notify/keys.ts agentForKey), so its API keys and
 *                   OPS_AGENT_TOKENS entry stop working. Its keys, tasks, claims
 *                   and memory are kept; re-enabling restores it as it was.
 *   can_send        lp.actors.can_send (0001). Recorded and returned by the ops
 *                   `whoami` op; no code path enforces it today, and every Instantly
 *                   change still waits for a human OK in "Needs your OK".
 *
 * Only kind = 'agent' rows. People are managed on Team / Users; 'system' and
 * 'owner' can never be changed here. No ops-API op: like pause, only a person
 * does this. Every change is one row in the activity log.
 */

export const NAME_MAX = 80
const PROTECTED = new Set(['system', 'owner'])

interface AgentRow { id: string; kind: string; display_name: string; active: boolean; can_send: boolean }

async function ownerName(q: Queryable, by: string): Promise<string> {
  await requireOwnerActor(q, by, 'Only an owner can rename, disable or change what an agent may send.')
  const { rows } = await q.query<{ display_name: string }>('select display_name from lp.actors where id = $1', [by])
  return rows[0]?.display_name ?? by
}

async function agentRow(q: Queryable, id: string): Promise<AgentRow> {
  if (PROTECTED.has(id)) throw new OpsError(`'${id}' is built in and can't be changed here.`, 400)
  const { rows } = await q.query<AgentRow>('select id, kind, display_name, active, can_send from lp.actors where id = $1 for update', [id])
  const a = rows[0]
  if (!a) throw new OpsError(`No actor '${id}'.`, 404)
  if (a.kind !== 'agent') throw new OpsError(`${a.display_name} is a person; people are managed on the Team page.`, 400)
  return a
}

export function cleanAgentName(raw: string | null | undefined): string {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!t) throw new OpsError('Give the agent a name.', 400)
  if (t.length > NAME_MAX) throw new OpsError(`Names are at most ${NAME_MAX} characters.`, 400)
  return t
}

export async function renameAgent(db: Db, by: string, agentId: string, newName: string): Promise<{ changed: boolean }> {
  const name = cleanAgentName(newName)
  return db.tx(async (q) => {
    const byName = await ownerName(q, by)
    const a = await agentRow(q, agentId)
    if (a.display_name === name) return { changed: false }
    await q.query('update lp.actors set display_name = $2 where id = $1', [agentId, name])
    await logEvent(q, {
      actor: by,
      kind: 'agent.renamed',
      summary: `${byName} renamed ${a.display_name} to ${name}.`,
      entity_type: 'actor',
      entity_id: agentId,
      data: { from: a.display_name, to: name },
    })
    return { changed: true }
  }, by)
}

export async function setAgentActive(db: Db, by: string, agentId: string, active: boolean): Promise<{ changed: boolean }> {
  return db.tx(async (q) => {
    const byName = await ownerName(q, by)
    const a = await agentRow(q, agentId)
    if (a.active === active) return { changed: false }
    await q.query('update lp.actors set active = $2 where id = $1', [agentId, active])
    await logEvent(q, {
      actor: by,
      kind: active ? 'agent.enabled' : 'agent.disabled',
      summary: active
        ? `${byName} re-enabled ${a.display_name}. Its API keys work again.`
        : `${byName} disabled ${a.display_name}. Its API keys are refused; its tasks, claims and memory are kept.`,
      entity_type: 'actor',
      entity_id: agentId,
      data: { active },
    })
    return { changed: true }
  }, by)
}

export async function setAgentCanSend(db: Db, by: string, agentId: string, canSend: boolean): Promise<{ changed: boolean }> {
  return db.tx(async (q) => {
    const byName = await ownerName(q, by)
    const a = await agentRow(q, agentId)
    if (a.can_send === canSend) return { changed: false }
    await q.query('update lp.actors set can_send = $2 where id = $1', [agentId, canSend])
    await logEvent(q, {
      actor: by,
      kind: 'agent.can_send',
      summary: `${byName} ${canSend ? 'marked' : 'unmarked'} ${a.display_name} as allowed to send after approval.`,
      entity_type: 'actor',
      entity_id: agentId,
      data: { from: a.can_send, to: canSend },
    })
    return { changed: true }
  }, by)
}

export interface DisabledAgent { id: string; display_name: string; harness: string | null; last_seen_at: Date | null }

/** Agents switched off with setAgentActive(false); listActors only shows active rows. */
export async function listDisabledAgents(q: Queryable): Promise<DisabledAgent[]> {
  const { rows } = await q.query<DisabledAgent>(
    "select id, display_name, harness, last_seen_at from lp.actors where kind = 'agent' and not active order by display_name",
  )
  return rows
}
