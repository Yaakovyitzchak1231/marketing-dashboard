/**
 * The tools hub: the tools Yaakov runs next to the dashboard (Warmbly,
 * Listmonk, Miniflux, changedetection.io, Umami on his OVH server, plus the
 * build tracker sheet and the plan doc) and the numbers the background
 * runner reads from each tool's API, as rows -- never a URL hard-coded in
 * app code.
 *
 * The dashboard never calls a tool directly: the OVH runner (lib/jobs, once
 * merged) polls each tool's API and writes health + snapshots here through
 * the ops API. This module only reads/writes those rows.
 */
import type { Queryable } from '../db/types'

export type ReachableFrom = 'public' | 'tailnet' | 'localhost'
export type Visibility = 'owner' | 'team' | 'hidden'
export type HealthStatus = 'ok' | 'degraded' | 'down' | 'unknown'

export interface Integration {
  id: string
  name: string
  kind: string
  description: string | null
  url: string | null
  api_url: string | null
  reachable_from: ReachableFrom
  settings_prefix: string | null
  visibility: Visibility
  sort: number
  active: boolean
  health_status: HealthStatus | null
  health_detail: string | null
  health_checked_at: Date | null
  created_by: string | null
  updated_by: string | null
  created_at: Date
  updated_at: Date
}

export interface IntegrationSnapshot {
  id: number
  integration_id: string
  campaign_id: number | null
  metric: string
  value: number | null
  dims: Record<string, unknown>
  data: unknown
  taken_at: Date
  job_run_id: number | null
  source: string
}

export class IntegrationError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

const ID_RE = /^[a-z][a-z0-9_-]{0,40}$/
const KIND_RE = /^[a-z][a-z0-9_]{0,40}$/
const SETTINGS_PREFIX_RE = /^[a-z][a-z0-9_.]{0,79}$/
const REACHABLE_FROM: ReachableFrom[] = ['public', 'tailnet', 'localhost']
const VISIBILITY: Visibility[] = ['owner', 'team', 'hidden']
const HEALTH_STATUS: HealthStatus[] = ['ok', 'degraded', 'down', 'unknown']

function isHttpUrl(v: string): boolean {
  return /^https?:\/\//.test(v)
}

function row(r: Record<string, unknown>): Integration {
  return {
    ...(r as unknown as Integration),
    sort: Number(r.sort),
    active: Boolean(r.active),
    health_checked_at: r.health_checked_at ? new Date(r.health_checked_at as string) : null,
    created_at: new Date(r.created_at as string),
    updated_at: new Date(r.updated_at as string),
  }
}

const COLS = `id, name, kind, description, url, api_url, reachable_from, settings_prefix, visibility, sort,
  active, health_status, health_detail, health_checked_at, created_by, updated_by, created_at, updated_at`

export async function listIntegrations(q: Queryable, opts: { activeOnly?: boolean } = {}): Promise<Integration[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select ${COLS} from lp.integrations where ($1::boolean is not true or active) order by sort, id`,
    [opts.activeOnly ?? false],
  )
  return rows.map(row)
}

export async function getIntegration(q: Queryable, id: string): Promise<Integration | null> {
  const { rows } = await q.query<Record<string, unknown>>(`select ${COLS} from lp.integrations where id = $1`, [id])
  return rows[0] ? row(rows[0]) : null
}

export interface IntegrationPatch {
  name?: string
  kind?: string
  description?: string | null
  url?: string | null
  api_url?: string | null
  reachable_from?: ReachableFrom
  settings_prefix?: string | null
  visibility?: Visibility
  sort?: number
  active?: boolean
}

/** Validate a patch's shape (both create and edit go through this). */
function validatePatch(p: IntegrationPatch, opts: { create?: boolean } = {}): void {
  if (opts.create && (!p.name || !p.name.trim())) throw new IntegrationError('name is required')
  if (p.name !== undefined && (!p.name.trim() || p.name.length > 80)) throw new IntegrationError('name must be 1-80 characters')
  if (opts.create && (!p.kind || !KIND_RE.test(p.kind))) throw new IntegrationError('kind is required and must be a lowercase slug (letters, digits, underscore)')
  if (p.kind !== undefined && !KIND_RE.test(p.kind)) throw new IntegrationError(`"${p.kind}" is not a valid kind slug`)
  if (p.description != null && p.description.length > 500) throw new IntegrationError('description must be 500 characters or fewer')
  if (p.url != null && p.url !== '' && !isHttpUrl(p.url)) throw new IntegrationError('url must start with http:// or https://')
  if (p.api_url != null && p.api_url !== '' && !isHttpUrl(p.api_url)) throw new IntegrationError('api_url must start with http:// or https://')
  if (p.reachable_from !== undefined && !REACHABLE_FROM.includes(p.reachable_from)) throw new IntegrationError(`reachable_from must be one of: ${REACHABLE_FROM.join(', ')}`)
  if (p.settings_prefix != null && p.settings_prefix !== '' && !SETTINGS_PREFIX_RE.test(p.settings_prefix)) throw new IntegrationError('settings_prefix must look like "integrations.<id>"')
  if (p.visibility !== undefined && !VISIBILITY.includes(p.visibility)) throw new IntegrationError(`visibility must be one of: ${VISIBILITY.join(', ')}`)
  if (p.sort !== undefined && !Number.isFinite(p.sort)) throw new IntegrationError('sort must be a number')
}

/** One lp.status_history row per changed field, keyed by the integration's slug (entity_id is null for slug-keyed entities -- schema v3). */
async function auditIntegrationChange(q: Queryable, actor: string, id: string, field: string, oldValue: unknown, newValue: unknown, via: string): Promise<void> {
  if (oldValue === newValue) return
  await q.query(
    `insert into lp.status_history (entity_type, entity_key, field, old_value, new_value, changed_by, via)
     values ('integration', $1, $2, $3, $4, $5, $6)`,
    [id, field, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), actor, via],
  )
}

/** Create (no existing row) or edit (row exists) an integration. Owner-only -- checked by the caller (ops / server action). */
export async function upsertIntegration(
  q: Queryable,
  actor: string,
  id: string,
  patch: IntegrationPatch,
  opts: { via?: string } = {},
): Promise<Integration> {
  if (!ID_RE.test(id)) throw new IntegrationError(`"${id}" is not a valid integration id (lowercase slug)`)
  const via = opts.via ?? 'ops_api'
  const existing = await getIntegration(q, id)
  validatePatch(patch, { create: !existing })
  if (!existing) {
    const { rows } = await q.query<Record<string, unknown>>(
      `insert into lp.integrations
        (id, name, kind, description, url, api_url, reachable_from, settings_prefix, visibility, sort, active, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
       returning ${COLS}`,
      [
        id,
        patch.name!.trim(),
        patch.kind!,
        patch.description ?? null,
        patch.url || null,
        patch.api_url || null,
        patch.reachable_from ?? 'public',
        patch.settings_prefix || null,
        patch.visibility ?? 'owner',
        patch.sort ?? 100,
        patch.active ?? true,
        actor,
      ],
    )
    await auditIntegrationChange(q, actor, id, 'created', null, patch.name!.trim(), via)
    return row(rows[0])
  }
  const next: Record<string, unknown> = { ...existing, ...patch }
  const { rows } = await q.query<Record<string, unknown>>(
    `update lp.integrations set
       name = $2, kind = $3, description = $4, url = $5, api_url = $6, reachable_from = $7,
       settings_prefix = $8, visibility = $9, sort = $10, active = $11, updated_by = $12
     where id = $1
     returning ${COLS}`,
    [
      id,
      String(next.name).trim(),
      next.kind,
      next.description ?? null,
      next.url || null,
      next.api_url || null,
      next.reachable_from,
      next.settings_prefix || null,
      next.visibility,
      Number(next.sort),
      Boolean(next.active),
      actor,
    ],
  )
  const FIELDS: (keyof Integration)[] = ['name', 'kind', 'description', 'url', 'api_url', 'reachable_from', 'settings_prefix', 'visibility', 'sort', 'active']
  for (const f of FIELDS) {
    if (f in patch) await auditIntegrationChange(q, actor, id, f, (existing as unknown as Record<string, unknown>)[f], (next as Record<string, unknown>)[f], via)
  }
  return row(rows[0])
}

/** The OVH runner (actor 'system') or the owner reports what it saw at a tool's health/root endpoint. */
export async function reportHealth(
  q: Queryable,
  id: string,
  health: { status: HealthStatus; detail?: string | null },
): Promise<Integration> {
  if (!HEALTH_STATUS.includes(health.status)) throw new IntegrationError(`status must be one of: ${HEALTH_STATUS.join(', ')}`)
  const existing = await getIntegration(q, id)
  if (!existing) throw new IntegrationError(`no integration "${id}"`, 404)
  const { rows } = await q.query<Record<string, unknown>>(
    `update lp.integrations set health_status = $2, health_detail = $3, health_checked_at = now()
     where id = $1 returning ${COLS}`,
    [id, health.status, health.detail ?? null],
  )
  return row(rows[0])
}

export interface SnapshotInput {
  metric: string
  value: number | null
  dims?: Record<string, unknown>
  data?: unknown
  campaign_id?: number | null
}

const METRIC_RE = /^[a-z][a-z0-9_.]{0,63}$/

/** Batch-write the numbers the runner read from one tool's API. NULL means the tool didn't say -- never coerced to 0. */
export async function addSnapshots(
  q: Queryable,
  id: string,
  snapshots: SnapshotInput[],
  opts: { jobRunId?: number | null; source?: string } = {},
): Promise<{ inserted: number }> {
  const existing = await getIntegration(q, id)
  if (!existing) throw new IntegrationError(`no integration "${id}"`, 404)
  if (!snapshots.length) return { inserted: 0 }
  if (snapshots.length > 500) throw new IntegrationError('at most 500 snapshots per call')
  for (const s of snapshots) {
    if (!s.metric || !METRIC_RE.test(s.metric)) throw new IntegrationError(`"${s.metric}" is not a valid metric slug`)
    if (s.value != null && typeof s.value !== 'number') throw new IntegrationError(`snapshot value for "${s.metric}" must be a number or null`)
  }
  const source = opts.source ?? 'runner'
  const jobRunId = opts.jobRunId ?? null
  const values: unknown[] = []
  const tuples: string[] = []
  snapshots.forEach((s, i) => {
    const base = i * 8
    tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5}::jsonb,$${base + 6}::jsonb,$${base + 7},$${base + 8})`)
    values.push(id, s.campaign_id ?? null, s.metric, s.value ?? null, JSON.stringify(s.dims ?? {}), JSON.stringify(s.data ?? null), jobRunId, source)
  })
  const { rowCount } = await q.query(
    `insert into lp.integration_snapshots (integration_id, campaign_id, metric, value, dims, data, job_run_id, source)
     values ${tuples.join(',')}`,
    values,
  )
  return { inserted: rowCount ?? snapshots.length }
}

export interface LatestMetric {
  integration_id: string
  metric: string
  value: number | null
  dims: Record<string, unknown>
  data: unknown
  campaign_id: number | null
  taken_at: Date
  source: string
}

/** The latest snapshot per (integration, metric, campaign). Used by the /tools page and any agent reading current numbers. */
export async function latestMetrics(
  q: Queryable,
  opts: { integrationId?: string | null; campaignId?: number | null } = {},
): Promise<LatestMetric[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select distinct on (integration_id, metric, campaign_id)
        integration_id, metric, value, dims, data, campaign_id, taken_at, source
       from lp.integration_snapshots
      where ($1::text is null or integration_id = $1)
        and ($2::bigint is null or campaign_id = $2)
      order by integration_id, metric, campaign_id, taken_at desc`,
    [opts.integrationId ?? null, opts.campaignId ?? null],
  )
  return rows.map((r) => ({
    integration_id: String(r.integration_id),
    metric: String(r.metric),
    value: r.value == null ? null : Number(r.value),
    dims: (r.dims as Record<string, unknown>) ?? {},
    data: r.data ?? null,
    campaign_id: r.campaign_id == null ? null : Number(r.campaign_id),
    taken_at: new Date(r.taken_at as string),
    source: String(r.source),
  }))
}


/**
 * Small read-only lookups the runner's pollers use to tie a tool's own
 * grouping (a Listmonk list, an Umami UTM campaign value) to a dashboard
 * campaign, via lp.campaign_profiles (owned by the campaign-profiles module;
 * this is a plain read against its table, not an import of that module, so
 * it carries no merge conflict with it).
 */
export async function campaignIdForNewsletterList(q: Queryable, listName: string): Promise<number | null> {
  const { rows } = await q.query<{ campaign_id: number }>(
    `select campaign_id from lp.campaign_profiles where lower(newsletter_list) = lower($1) limit 1`,
    [listName],
  )
  return rows[0] ? Number(rows[0].campaign_id) : null
}

export async function campaignIdForUtmCampaign(q: Queryable, utmCampaign: string): Promise<number | null> {
  const { rows } = await q.query<{ campaign_id: number }>(
    `select campaign_id from lp.campaign_profiles where lower(utm->>'campaign') = lower($1) limit 1`,
    [utmCampaign],
  )
  return rows[0] ? Number(rows[0].campaign_id) : null
}
