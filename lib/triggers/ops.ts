/**
 * Plan 3.2 ops. Editors save triggers. Viewers can list them and read fires.
 * scan_due_triggers is owner-or-system (the trigger_scan job). The API token
 * is returned once, on create or rotate, and never listed back.
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { requireOwnerOrSystem } from '../ops/actor-role.ts'
import {
  TRIGGER_KINDS,
  TriggerError,
  fireApiTrigger,
  newTriggerToken,
  hashTriggerToken,
  scanDueTriggers,
  validateTriggerConfig,
  type TriggerKind,
} from './match.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function id(v: unknown, field: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new OpsError(`${field} must be a positive integer`)
  return n
}

function kindOf(v: unknown): TriggerKind {
  const k = typeof v === 'string' ? v.trim() : ''
  if (!(TRIGGER_KINDS as readonly string[]).includes(k)) throw new OpsError(`kind must be one of: ${TRIGGER_KINDS.join(', ')}`)
  return k as TriggerKind
}

function asTriggerError(e: unknown): never {
  if (e instanceof TriggerError) throw new OpsError(e.message, e.status)
  throw e
}

const RAW: Record<string, Op> = {
  list_triggers: {
    args: '{campaign_id?, include_disabled?}  -- trigger definitions, never the API token',
    run: async (db, _actor, a) => {
      const campaignId = a.campaign_id == null || a.campaign_id === '' ? null : id(a.campaign_id, 'campaign_id')
      const includeDisabled = a.include_disabled === true || a.include_disabled === 'true'
      const { rows } = await db.query(
        `select id, name, kind, campaign_id, config, enabled, (token_hash is not null) as has_token, created_by, created_at, updated_at
           from lp.triggers
          where ($1::bigint is null or campaign_id = $1)
            and ($2::boolean or enabled)
          order by id`,
        [campaignId, includeDisabled],
      )
      return { triggers: rows }
    },
  },
  recent_trigger_fires: {
    args: '{trigger_id?, limit?}  -- newest fires first, at most 200',
    run: async (db, _actor, a) => {
      const triggerId = a.trigger_id == null || a.trigger_id === '' ? null : id(a.trigger_id, 'trigger_id')
      const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 200)
      const { rows } = await db.query(
        `select id, trigger_id, company_id, contact_id, fired_at, payload
           from lp.trigger_fires
          where ($1::bigint is null or trigger_id = $1)
          order by fired_at desc, id desc
          limit $2`,
        [triggerId, limit],
      )
      return { fires: rows }
    },
  },
  upsert_trigger: {
    args: '{id?, name, kind, config, campaign_id?, enabled?, rotate_token?}  -- api triggers return token once',
    run: async (db, actor, a) => {
      const name = typeof a.name === 'string' ? a.name.trim() : ''
      if (!name || name.length > 120) throw new OpsError('name is required (max 120 characters)')
      const kind = kindOf(a.kind)
      let config: Record<string, unknown>
      try {
        config = validateTriggerConfig(kind, a.config ?? {})
      } catch (e) {
        asTriggerError(e)
      }
      const campaignId = a.campaign_id == null || a.campaign_id === '' ? null : id(a.campaign_id, 'campaign_id')
      const enabled = a.enabled !== false && a.enabled !== 'false'
      const rotate = a.rotate_token === true || a.rotate_token === 'true'
      const existingId = a.id == null || a.id === '' ? null : id(a.id, 'id')
      let token: string | null = null
      let tokenHash: string | null = null
      if (kind === 'api' && (existingId == null || rotate)) {
        token = newTriggerToken()
        tokenHash = hashTriggerToken(token)
      }
      if (existingId == null) {
        const { rows } = await db.query(
          `insert into lp.triggers (name, kind, campaign_id, config, enabled, token_hash, created_by)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning id, name, kind, campaign_id, config, enabled, created_at`,
          [name, kind, campaignId, JSON.stringify(config), enabled, tokenHash, actor],
        )
        return { ...rows[0], token }
      }
      const cur = await db.query<{ kind: string; token_hash: string | null }>(
        'select kind, token_hash from lp.triggers where id = $1',
        [existingId],
      )
      if (!cur.rows[0]) throw new OpsError('no trigger with that id', 404)
      if (cur.rows[0].kind !== kind) throw new OpsError('kind cannot be changed; create a new trigger')
      const nextHash = tokenHash ?? cur.rows[0].token_hash
      const { rows } = await db.query(
        `update lp.triggers
            set name = $2, campaign_id = $3, config = $4, enabled = $5, token_hash = $6
          where id = $1
          returning id, name, kind, campaign_id, config, enabled, updated_at`,
        [existingId, name, campaignId, JSON.stringify(config), enabled, nextHash],
      )
      return { ...rows[0], token }
    },
  },
  set_trigger_enabled: {
    args: '{id, enabled}',
    run: async (db, _actor, a) => {
      const triggerId = id(a.id, 'id')
      const enabled = a.enabled === true || a.enabled === 'true'
      const { rows } = await db.query(
        'update lp.triggers set enabled = $2 where id = $1 returning id, enabled',
        [triggerId, enabled],
      )
      if (!rows[0]) throw new OpsError('no trigger with that id', 404)
      return rows[0]
    },
  },
  fire_api_trigger: {
    args: '{token, company_id? | contact_id? | email, payload?, dedupe_key?}  -- the token is the credential',
    run: async (db, _actor, a) => {
      try {
        return await fireApiTrigger(db, {
          token: typeof a.token === 'string' ? a.token : '',
          company_id: a.company_id == null ? null : id(a.company_id, 'company_id'),
          contact_id: a.contact_id == null ? null : id(a.contact_id, 'contact_id'),
          email: typeof a.email === 'string' ? a.email : null,
          payload: a.payload && typeof a.payload === 'object' && !Array.isArray(a.payload) ? a.payload as Record<string, unknown> : {},
          dedupe_key: typeof a.dedupe_key === 'string' ? a.dedupe_key : null,
        })
      } catch (e) {
        asTriggerError(e)
      }
    },
  },
  scan_due_triggers: {
    args: '{}  -- owner or the runner (system). Evaluates date, schedule, and segment entry/exit.',
    run: async (db, actor) => {
      await requireOwnerOrSystem(db, actor, 'scan_due_triggers is owner-only (the runner calls it as system).')
      return scanDueTriggers(db)
    },
  },
}

export const TRIGGER_OPS: Record<string, Op> = RAW
