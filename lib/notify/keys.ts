/**
 * Agent API keys kept in the database (hashed). The whole key is returned once, when
 * minted; afterwards only its last 4 characters are shown. OPS_AGENT_TOKENS (env) keeps
 * working beside these, so nothing breaks while agents move over.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Queryable } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'

export function hashKey(key: string): string {
  return createHash('sha256').update(key.trim(), 'utf8').digest('hex')
}

export interface AgentKeyRow {
  id: number
  actor_id: string
  hint: string
  label: string | null
  created_by: string | null
  created_at: Date
  last_used_at: Date | null
  revoked_at: Date | null
}

/** Mint a key for an agent. Returns the full key exactly once. */
export async function mintAgentKey(q: Queryable, by: string, actorId: string, label?: string | null): Promise<{ key: string; row: AgentKeyRow }> {
  const a = await q.query<{ kind: string }>('select kind from lp.actors where id = $1 and active', [actorId])
  if (!a.rows[0]) throw new OpsError(`unknown or inactive actor '${actorId}'`, 404)
  if (a.rows[0].kind !== 'agent') throw new OpsError('keys are for agents; people sign in with their login', 400)
  const key = `mdk_${actorId.replace(/[^a-z0-9]/g, '')}_${randomBytes(24).toString('base64url')}`
  const { rows } = await q.query<AgentKeyRow>(
    `insert into lp.agent_keys (actor_id, key_hash, hint, label, created_by) values ($1, $2, $3, $4, $5)
     returning id, actor_id, hint, label, created_by, created_at, last_used_at, revoked_at`,
    [actorId, hashKey(key), key.slice(-4), label?.trim().slice(0, 80) || null, by],
  )
  await q.query(
    `insert into lp.events (actor, kind, summary, entity_type, entity_id) values ($1, 'agent.key_minted', $2, 'actor', $3)`,
    [by, `New API key for ${actorId} (…${key.slice(-4)})${label ? ` "${label}"` : ''}`, actorId],
  )
  return { key, row: rows[0] }
}

export async function revokeAgentKey(q: Queryable, by: string, keyId: number): Promise<boolean> {
  const { rows } = await q.query<{ actor_id: string; hint: string }>(
    'update lp.agent_keys set revoked_at = now(), revoked_by = $2 where id = $1 and revoked_at is null returning actor_id, hint',
    [keyId, by],
  )
  if (!rows[0]) return false
  await q.query(
    `insert into lp.events (actor, kind, summary, entity_type, entity_id) values ($1, 'agent.key_revoked', $2, 'actor', $3)`,
    [by, `Revoked API key …${rows[0].hint} of ${rows[0].actor_id}`, rows[0].actor_id],
  )
  return true
}

export async function listAgentKeys(q: Queryable, actorId: string): Promise<AgentKeyRow[]> {
  const { rows } = await q.query<AgentKeyRow>(
    `select id, actor_id, hint, label, created_by, created_at, last_used_at, revoked_at
       from lp.agent_keys where actor_id = $1 order by revoked_at nulls first, created_at desc`,
    [actorId],
  )
  return rows
}

/** The agent a bearer key belongs to (live key, active agent), or null. Marks the key used. */
export async function agentForDbKey(q: Queryable, authorization: string | null): Promise<string | null> {
  if (!authorization) return null
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  if (!m) return null
  const { rows } = await q.query<{ id: number; actor_id: string }>(
    `select k.id, k.actor_id from lp.agent_keys k join lp.actors a on a.id = k.actor_id
      where k.key_hash = $1 and k.revoked_at is null and a.active and a.kind = 'agent'`,
    [hashKey(m[1])],
  )
  if (!rows[0]) return null
  await q.query('update lp.agent_keys set last_used_at = now() where id = $1', [rows[0].id])
  return rows[0].actor_id
}

/** Add an agent (or person) to the team. */
export async function addActor(
  q: Queryable,
  by: string,
  a: { id: string; display_name: string; kind?: 'agent' | 'human'; harness?: string | null },
): Promise<{ id: string }> {
  const id = a.id.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(id)) throw new OpsError('id: lowercase letters, digits, dot, dash or underscore (e.g. "claude-code")')
  const name = a.display_name.trim().slice(0, 80)
  if (!name) throw new OpsError('display name is required')
  const exists = await q.query('select 1 from lp.actors where id = $1', [id])
  if (exists.rows.length) throw new OpsError(`'${id}' already exists`, 409)
  await q.query(
    `insert into lp.actors (id, kind, display_name, harness, created_by, quiet_shabbos) values ($1, $2, $3, $4, $5, $6)`,
    [id, a.kind ?? 'agent', name, a.harness?.trim().slice(0, 40) || null, by, (a.kind ?? 'agent') === 'human'],
  )
  await q.query(
    `insert into lp.events (actor, kind, summary, entity_type, entity_id) values ($1, 'agent.added', $2, 'actor', $3)`,
    [by, `Added ${a.kind === 'human' ? 'person' : 'agent'} ${name} (${id})`, id],
  )
  return { id }
}
