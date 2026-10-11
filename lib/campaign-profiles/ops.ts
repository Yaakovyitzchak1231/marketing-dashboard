/**
 * Campaign-profile ops for agents (POST /api/ops {op, ...} and the REST
 * aliases in lib/ops/dispatch.ts) and the dashboard (as 'owner'). Every write
 * is campaign-agnostic: nothing here assumes an industry.
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import {
  ProfileError,
  addItems,
  approvedItems,
  copyProfile,
  getProfile,
  setItemStatus,
  setItemVerify,
  updateItem,
  upsertProfile,
  ITEM_KINDS,
  ITEM_STATUSES,
  type ItemKind,
  type ItemStatus,
} from './store.ts'
// suggest.ts imports 'server-only' (it calls an external AI provider); load it on first use so this
// table (reached by dispatch.ts, which many test files import) stays importable anywhere, the same way
// lib/ops/dispatch.ts lazy-loads the Instantly gate for the same reason.
const suggestModule = () => import('./suggest.ts')
import { verifyItem } from './verify.ts'
import { createPool, listPools } from './pools.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function cid(v: unknown, field = 'campaign_id'): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new OpsError(`${field} must be a positive integer`)
  return n
}

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof ProfileError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

const strip = (a: Args, ...keys: string[]) => Object.fromEntries(Object.entries(a).filter(([k]) => !keys.includes(k)))

function ids(v: unknown): number[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : null
  if (!list) throw new OpsError('ids must be a list.')
  const out = list.map((x) => cid(x, 'id'))
  if (!out.length) throw new OpsError('ids must be a non-empty list.')
  return out
}

const RAW: Record<string, Op> = {
  get_campaign_profile: {
    args: '{campaign_id}  -> {profile, items (grouped by kind), exists}',
    run: (db, _actor, a) => getProfile(db, cid(a.campaign_id)),
  },
  update_campaign_profile: {
    args: '{campaign_id, industry?, vertical?, description?, icp?, value_prop?, newsletter_list?, utm?, kpis?, setup_status?}',
    run: (db, actor, a) => upsertProfile(db, actor, cid(a.campaign_id), strip(a, 'campaign_id') as never),
  },
  add_profile_items: {
    args: `{campaign_id, items: [{kind: ${ITEM_KINDS.join('|')}, name, value?, config?, status? (default approved), source? (default human), rationale?, sort?}]}`,
    run: (db, actor, a) => addItems(db, actor, cid(a.campaign_id), Array.isArray(a.items) ? a.items : [], 'ops_api'),
  },
  set_profile_item_status: {
    args: `{ids: [item id...], status: ${ITEM_STATUSES.join('|')}}`,
    run: (db, actor, a) => setItemStatus(db, actor, ids(a.ids), a.status as ItemStatus, 'ops_api'),
  },
  update_profile_item: {
    args: '{id, name?, value?, config?, rationale?, sort?}',
    run: (db, actor, a) => updateItem(db, actor, cid(a.id, 'id'), { name: a.name as string | undefined, value: a.value as string | null | undefined, config: a.config as Record<string, unknown> | undefined, rationale: a.rationale as string | null | undefined, sort: a.sort as number | undefined }),
  },
  suggest_campaign_profile: {
    args: '{campaign_id, industry, notes?, example_sites?: string[]}  -> saves suggested items, never auto-approved; {configured:false, reason} if no AI provider is set up',
    run: async (db, actor, a) => {
      const { suggestCampaignProfile } = await suggestModule()
      return suggestCampaignProfile(db, actor, { campaign_id: cid(a.campaign_id), industry: String(a.industry ?? ''), notes: a.notes as string | undefined, example_sites: Array.isArray(a.example_sites) ? (a.example_sites as string[]) : undefined })
    },
  },
  copy_campaign_profile: {
    args: '{from, to}  -- copies profile scalars + items (source becomes "copied")',
    run: (db, actor, a) => copyProfile(db, actor, cid(a.from, 'from'), cid(a.to, 'to')),
  },
  list_pools: {
    args: '{include_inactive?}  -- industries/audiences for a campaign pool picker; never a hard-coded list',
    run: (db, _actor, a) => listPools(db, { include_inactive: a.include_inactive === true || a.include_inactive === 'true' }),
  },
  create_pool: {
    args: '{label, id?, description?}  -- adds a new pool (industry/audience) when the wizard\'s picker doesn\'t already have one',
    run: (db, actor, a) => createPool(db, actor, String(a.label ?? ''), { id: typeof a.id === 'string' ? a.id : undefined, description: a.description as string | null | undefined }),
  },
  recheck_profile_item: {
    args: '{id}  -- re-run verification on one item (the "Re-check" button) and save the result',
    run: async (db, actor, a) => {
      const itemId = cid(a.id, 'id')
      const { rows } = await db.query<Record<string, unknown>>(
        `select id, kind, name, value, config from lp.campaign_profile_items where id = $1`,
        [itemId],
      )
      if (!rows[0]) throw new OpsError(`No profile item ${itemId}.`, 404)
      const target = { kind: rows[0].kind as string, name: rows[0].name as string, value: rows[0].value as string | null, config: rows[0].config as Record<string, unknown> }
      const outcome = await verifyItem(target as never)
      return setItemVerify(db, actor, itemId, { status: outcome.status, detail: outcome.detail })
    },
  },
  list_profile_items: {
    args: `{kind: ${ITEM_KINDS.join('|')}, status? (default approved), campaign_id?}  -- so a monitor/connector agent can fetch every approved item of a kind, across one or all active campaigns`,
    run: async (db, _actor, a) => {
      if (!a.kind || typeof a.kind !== 'string' || !(ITEM_KINDS as readonly string[]).includes(a.kind)) {
        throw new OpsError(`kind must be one of: ${ITEM_KINDS.join(', ')}.`)
      }
      const kind = a.kind as ItemKind
      const status = typeof a.status === 'string' ? a.status : 'approved'
      if (a.campaign_id != null) {
        if (status !== 'approved') throw new OpsError('Only approved items are listed by this op (pass no status, or "approved").')
        return approvedItems(db, cid(a.campaign_id), kind)
      }
      // Across every (non-archived) campaign: used by monitors/connectors that run for all active campaigns.
      const { rows } = await db.query<Record<string, unknown>>(
        `select i.id, i.campaign_id, i.kind, i.name, i.value, i.config, i.status, i.source, i.rationale, i.sort, i.created_by, i.updated_by, i.created_at, i.updated_at
         from lp.campaign_profile_items i
         join lp.campaigns c on c.id = i.campaign_id
         where i.kind = $1 and i.status = $2 and c.status <> 'archived'
         order by i.campaign_id, i.sort, lower(i.name)`,
        [kind, status],
      )
      return rows
    },
  },
}

export const CAMPAIGN_PROFILE_OPS: Record<string, Op> = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, { args: v.args, run: wrap(v.run) }]))
