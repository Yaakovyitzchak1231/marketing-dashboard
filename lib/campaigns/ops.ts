/**
 * Campaign ops for agents (POST /api/ops {op, ...} and the REST aliases in
 * lib/ops/dispatch.ts). Agents can create, edit, duplicate, archive campaigns
 * and build their lead lists; every change is in the activity log with the
 * agent's id and old -> new. None of these ops touches Instantly.
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import {
  addStatus,
  archiveCampaign,
  createCampaign,
  duplicateCampaign,
  getCampaign,
  listCampaigns,
  listStatuses,
  updateCampaign,
} from './store.ts'
import {
  addLeadsByFilter,
  addLeadsByIds,
  getCampaignLead,
  listCampaignLeads,
  parseLeadPatch,
  previewPick,
  removeLeads,
  updateCampaignLead,
} from './leads.ts'
import { tierCountsFor } from './evaluator.ts'
import { CampaignError, parseCampaignPatch, parseIds, parsePick } from './types.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function cid(v: unknown, field = 'campaign_id'): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new OpsError(`${field} must be a positive integer`)
  return n
}

/** CampaignError -> OpsError with the same status, so the ops route answers 400/404/409. */
function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof CampaignError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

const strip = (a: Args, ...keys: string[]) => Object.fromEntries(Object.entries(a).filter(([k]) => !keys.includes(k)))

const RAW: Record<string, Op> = {
  list_campaigns: {
    args: '{include_archived?, pool?, status?, templates_only?}',
    run: (db, _actor, a) =>
      listCampaigns(db, {
        includeArchived: a.include_archived === true || a.include_archived === 'true',
        pool: typeof a.pool === 'string' ? a.pool : null,
        status: typeof a.status === 'string' ? a.status : null,
        templatesOnly: a.templates_only === true || a.templates_only === 'true',
      }),
  },
  get_campaign: {
    args: '{campaign_id}  -> the campaign, its rule set and Ready/Parked counts',
    run: async (db, _actor, a) => {
      const c = await getCampaign(db, cid(a.campaign_id))
      if (!c) throw new OpsError('campaign not found', 404)
      return { ...c, readiness: await tierCountsFor(db, c) }
    },
  },
  list_campaign_statuses: { args: '{}', run: (db) => listStatuses(db, { includeInactive: true }) },
  add_campaign_status: {
    args: '{id, label, is_archived?, sort?}',
    run: (db, actor, a) => addStatus(db, actor, { id: String(a.id ?? ''), label: String(a.label ?? ''), is_archived: a.is_archived === true, sort: a.sort == null ? undefined : Number(a.sort) }),
  },
  create_campaign: {
    args: '{name, pool?: jeweler|ai_agency|ai_builder|other, goal?, notes?, owner?, status? (default draft), rule_set_id? (null = pool rules), is_template?}',
    run: (db, actor, a) => createCampaign(db, actor, parseCampaignPatch(a, { create: true }) as { name: string }, { via: 'api' }),
  },
  update_campaign: {
    args: '{campaign_id, name?, pool?, goal?, notes?, owner?, status?, rule_set_id?, is_template?}  -> {campaign, changes: [{field, from, to}]}',
    run: (db, actor, a) => updateCampaign(db, actor, cid(a.campaign_id), parseCampaignPatch(strip(a, 'campaign_id'))),
  },
  duplicate_campaign: {
    args: '{campaign_id, name?, with_leads? (default true), as_template?}  -> a new draft copy',
    run: (db, actor, a) =>
      duplicateCampaign(db, actor, cid(a.campaign_id), {
        name: typeof a.name === 'string' ? a.name : null,
        withLeads: a.with_leads === undefined ? true : a.with_leads === true || a.with_leads === 'true',
        asTemplate: a.as_template === true || a.as_template === 'true',
      }),
  },
  archive_campaign: {
    args: '{campaign_id}',
    run: (db, actor, a) => archiveCampaign(db, actor, cid(a.campaign_id)),
  },
  list_campaign_leads: {
    args: "{campaign_id, q?, state?, tier?: ready_personalized|ready_generic|parked|not_scored, page?}  -> 100 per page, each with its Ready/Parked verdict and reasons",
    run: (db, _actor, a) =>
      listCampaignLeads(db, cid(a.campaign_id), {
        q: typeof a.q === 'string' ? a.q : null,
        state: typeof a.state === 'string' ? a.state : null,
        tier: typeof a.tier === 'string' ? (a.tier as 'parked') : null,
        page: a.page == null ? 1 : Number(a.page),
      }),
  },
  get_campaign_lead: {
    args: '{campaign_id, company_id}',
    run: async (db, _actor, a) => {
      const r = await getCampaignLead(db, cid(a.campaign_id), cid(a.company_id, 'company_id'))
      if (!r) throw new OpsError('that lead is not in this campaign', 404)
      return r
    },
  },
  add_campaign_leads: {
    args: '{campaign_id, company_ids?: number[]  OR  filter?: {pool?, stage?, contact_status?, verification?, state?, tag?, q?}, preview?: true (count only)}',
    run: async (db, actor, a) => {
      const id = cid(a.campaign_id)
      if (a.filter !== undefined) {
        const pick = parsePick(a.filter)
        if (a.preview === true || a.preview === 'true') return previewPick(db, id, pick)
        return addLeadsByFilter(db, actor, id, pick)
      }
      return addLeadsByIds(db, actor, id, parseIds(a.company_ids, 'company_ids'), 'api')
    },
  },
  remove_campaign_leads: {
    args: '{campaign_id, company_ids: number[]}  -- takes them off this list only; the leads are unchanged',
    run: (db, actor, a) => removeLeads(db, actor, cid(a.campaign_id), parseIds(a.company_ids, 'company_ids')),
  },
  update_campaign_lead: {
    args: '{campaign_id, company_id, overrides?: {field: value} (replace), overrides_merge?: {field: value|null}, contact_id?, note?, tags?: string[]}',
    run: (db, actor, a) => updateCampaignLead(db, actor, cid(a.campaign_id), cid(a.company_id, 'company_id'), parseLeadPatch(strip(a, 'campaign_id', 'company_id'))),
  },
}

export const CAMPAIGN_OPS: Record<string, Op> = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, { args: v.args, run: wrap(v.run) }]))

/** REST aliases under /api/ops/campaigns. */
export function campaignRoute(method: string, path: string[]): { op: string; args: Args } | null {
  const [a, b, c, d, e] = path
  if (a !== 'campaigns') return null
  if (!b) return method === 'GET' ? { op: 'list_campaigns', args: {} } : method === 'POST' ? { op: 'create_campaign', args: {} } : null
  if (b === 'statuses' && !c) return method === 'GET' ? { op: 'list_campaign_statuses', args: {} } : { op: 'add_campaign_status', args: {} }
  if (!/^\d+$/.test(b)) return null
  const id = { campaign_id: Number(b) }
  if (!c) return method === 'GET' ? { op: 'get_campaign', args: id } : null
  if (method === 'POST' && !d && (c === 'update' || c === 'duplicate' || c === 'archive')) return { op: `${c}_campaign`, args: id }
  if (c === 'leads') {
    if (!d) return method === 'GET' ? { op: 'list_campaign_leads', args: id } : { op: 'add_campaign_leads', args: id }
    if (d === 'remove' && method === 'POST' && !e) return { op: 'remove_campaign_leads', args: id }
    if (/^\d+$/.test(d) && !e) return method === 'GET' ? { op: 'get_campaign_lead', args: { ...id, company_id: Number(d) } } : { op: 'update_campaign_lead', args: { ...id, company_id: Number(d) } }
  }
  return null
}
