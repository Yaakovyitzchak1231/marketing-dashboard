/**
 * Tools hub ops for agents (POST /api/ops {op, ...} and the REST aliases in
 * lib/ops/dispatch.ts) and the dashboard (acting as 'owner'):
 *  - list_integrations, latest_integration_metrics: anyone authenticated may read.
 *  - put_integration: owner only (adding/editing a tool is a human decision).
 *  - report_integration_health, put_integration_snapshots: the OVH runner
 *    ('system') or the owner only -- these are what the runner writes after
 *    polling a tool's API.
 */
import type { Db } from '../db/types'
import { OpsError } from '../ops/core'
import {
  IntegrationError,
  addSnapshots,
  campaignIdForNewsletterList,
  campaignIdForUtmCampaign,
  getIntegration,
  latestMetrics,
  listIntegrations,
  reportHealth,
  upsertIntegration,
  type IntegrationPatch,
  type SnapshotInput,
} from './store'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof IntegrationError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new OpsError(`${field} is required`)
  return v.trim()
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s || null
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw new OpsError('expected a number or null')
  return n
}

/** Only the owner (a person) may add or edit tool rows -- which tools exist is a human decision. */
function requireOwner(actor: string): void {
  if (actor !== 'owner') throw new OpsError('only the owner can add or edit tools', 403)
}

/** Health reports and snapshots come from the OVH runner's own key ('system') or the owner -- never another agent. */
function requireRunnerOrOwner(actor: string): void {
  if (actor !== 'system' && actor !== 'owner') throw new OpsError("only the runner ('system') or the owner can report tool health or numbers", 403)
}

function patchFromArgs(a: Args): IntegrationPatch {
  const p: IntegrationPatch = {}
  if (a.name !== undefined) p.name = str(a.name, 'name')
  if (a.kind !== undefined) p.kind = str(a.kind, 'kind')
  if (a.description !== undefined) p.description = strOrNull(a.description)
  if (a.url !== undefined) p.url = strOrNull(a.url)
  if (a.api_url !== undefined) p.api_url = strOrNull(a.api_url)
  if (a.reachable_from !== undefined) p.reachable_from = str(a.reachable_from, 'reachable_from') as IntegrationPatch['reachable_from']
  if (a.settings_prefix !== undefined) p.settings_prefix = strOrNull(a.settings_prefix)
  if (a.visibility !== undefined) p.visibility = str(a.visibility, 'visibility') as IntegrationPatch['visibility']
  if (a.sort !== undefined) p.sort = Number(a.sort)
  if (a.active !== undefined) p.active = a.active === true || a.active === 'true'
  return p
}

function parseSnapshots(v: unknown): SnapshotInput[] {
  if (!Array.isArray(v)) throw new OpsError('snapshots must be an array')
  return v.map((raw, i) => {
    const s = raw as Args
    const metric = s.metric
    if (typeof metric !== 'string' || !metric.trim()) throw new OpsError(`snapshots[${i}].metric is required`)
    return {
      metric: metric.trim(),
      value: numOrNull(s.value),
      dims: (s.dims && typeof s.dims === 'object') ? (s.dims as Record<string, unknown>) : undefined,
      data: s.data,
      campaign_id: s.campaign_id == null ? null : Number(s.campaign_id),
    }
  })
}

export const INTEGRATION_OPS: Record<string, Op> = {
  list_integrations: {
    args: '{active_only?}  -> every tool / link row, sorted',
    run: (db, _actor, a) => listIntegrations(db, { activeOnly: a.active_only === true || a.active_only === 'true' }),
  },
  get_integration: {
    args: '{id}',
    run: wrap(async (db, _actor, a) => {
      const row = await getIntegration(db, str(a.id, 'id'))
      if (!row) throw new OpsError(`no integration "${a.id}"`, 404)
      return row
    }),
  },
  put_integration: {
    args: '{id, name, kind, description?, url?, api_url?, reachable_from? (public|tailnet|localhost), settings_prefix?, visibility? (owner|team|hidden), sort?, active?}  -- owner only',
    run: wrap(async (db, actor, a) => {
      requireOwner(actor)
      return db.tx((q) => upsertIntegration(q, actor, str(a.id, 'id'), patchFromArgs(a), { via: 'ops_api' }), actor)
    }),
  },
  report_integration_health: {
    args: '{id, status (ok|degraded|down|unknown), detail?}  -- the runner (system) or owner',
    run: wrap(async (db, actor, a) => {
      requireRunnerOrOwner(actor)
      return reportHealth(db, str(a.id, 'id'), { status: str(a.status, 'status') as 'ok' | 'degraded' | 'down' | 'unknown', detail: strOrNull(a.detail) })
    }),
  },
  put_integration_snapshots: {
    args: '{id, snapshots: [{metric, value, dims?, data?, campaign_id?}], job_run_id?}  -- batch; the runner (system) or owner',
    run: wrap(async (db, actor, a) => {
      requireRunnerOrOwner(actor)
      return addSnapshots(db, str(a.id, 'id'), parseSnapshots(a.snapshots), {
        jobRunId: a.job_run_id == null ? null : Number(a.job_run_id),
        source: actor === 'system' ? 'runner' : 'owner',
      })
    }),
  },
  latest_integration_metrics: {
    args: '{id?, campaign_id?}  -> the latest snapshot per (integration, metric, campaign)',
    run: (db, _actor, a) =>
      latestMetrics(db, {
        integrationId: a.id == null ? null : str(a.id, 'id'),
        campaignId: a.campaign_id == null ? null : Number(a.campaign_id),
      }),
  },
  // Small lookups the OVH runner's pollers use to tie a tool's own grouping
  // (a Listmonk list, an Umami UTM campaign value) to a dashboard campaign.
  campaign_for_newsletter_list: {
    args: '{list}  -> {campaign_id} | {campaign_id: null}',
    run: async (db, _actor, a) => ({ campaign_id: await campaignIdForNewsletterList(db, str(a.list, 'list')) }),
  },
  campaign_for_utm_campaign: {
    args: '{utm_campaign}  -> {campaign_id} | {campaign_id: null}',
    run: async (db, _actor, a) => ({ campaign_id: await campaignIdForUtmCampaign(db, str(a.utm_campaign, 'utm_campaign')) }),
  },
}
