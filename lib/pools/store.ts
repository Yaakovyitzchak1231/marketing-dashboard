/**
 * Pools: the industries/audiences a campaign can target. Rows in lp.pools
 * (migration 0020), not a fixed list in code. lp.campaigns.pool,
 * lp.companies.segment, lp.campaign_meta.segment and lp.rule_sets.segment
 * all reference lp.pools(id) with an ON UPDATE CASCADE foreign key, so
 * validity is "exists in lp.pools" (the DB enforces it; see mapPoolFkError).
 *
 * Adding a campaign for a brand-new industry is: create the pool, then the
 * campaign. Nothing about a pool is hard-coded; the four seeded rows
 * (jeweler, ai_agency, ai_builder, other) are just the first ones, kept for
 * history, not a ceiling.
 */
import type { Queryable } from '../db/types.ts'

export interface Pool {
  id: string
  label: string
  description: string | null
  sort: number
  active: boolean
  created_by: string | null
  created_at: Date
  updated_at: Date
}

const COLS = 'id, label, description, sort, active, created_by, created_at, updated_at'
const SLUG_RE = /^[a-z][a-z0-9_]{0,40}$/

export class PoolError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** "AI agencies" -> ai_agencies, truncated/validated to the lp.pools slug shape. */
export function slugifyPoolLabel(label: string): string {
  const s = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 41)
  if (!s || !/^[a-z]/.test(s)) return `pool_${s}`.slice(0, 41)
  return s
}

function parseSlug(v: unknown, field = 'id'): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (!SLUG_RE.test(s)) throw new PoolError(`${field} must start with a letter and use only lowercase letters, digits and _ (max 41 characters).`)
  return s
}

export async function listPools(q: Queryable, opts: { includeInactive?: boolean; include_inactive?: boolean } = {}): Promise<Pool[]> {
  // Accepts both includeInactive (this module's own style) and include_inactive
  // (snake_case, so a caller written against a different convention -- e.g. the
  // campaign-profiles PR's own pools helper -- is a drop-in without renaming).
  const includeInactive = Boolean(opts.includeInactive ?? opts.include_inactive)
  const { rows } = await q.query<Pool>(
    `select ${COLS} from lp.pools where $1 or active order by sort, label, id`,
    [includeInactive],
  )
  return rows
}

export async function getPool(q: Queryable, id: string): Promise<Pool | null> {
  const { rows } = await q.query<Pool>(`select ${COLS} from lp.pools where id = $1`, [id.trim().toLowerCase()])
  return rows[0] ?? null
}

export async function poolExists(q: Queryable, id: string): Promise<boolean> {
  const { rows } = await q.query('select 1 from lp.pools where id = $1', [id.trim().toLowerCase()])
  return rows.length > 0
}

export interface CreatePoolInput {
  id?: string
  label: string
  description?: string | null
  sort?: number
  active?: boolean
}

/** Create a pool. `id` defaults to a slug made from `label` when not given. */
export async function createPool(q: Queryable, actor: string, input: CreatePoolInput, via: 'ui' | 'ops_api' = 'ops_api'): Promise<Pool> {
  const label = String(input.label ?? '').trim()
  if (!label || label.length > 80) throw new PoolError('label is required (1-80 characters).')
  const id = input.id != null && String(input.id).trim() ? parseSlug(input.id) : slugifyPoolLabel(label)
  if (!SLUG_RE.test(id)) throw new PoolError(`"${id}" (from the label) is not a usable id. Give an explicit id.`)
  const description = input.description == null || input.description === '' ? null : String(input.description).trim().slice(0, 1000)
  const sort = input.sort == null ? 100 : Math.trunc(Number(input.sort))
  if (!Number.isFinite(sort)) throw new PoolError('sort must be a number.')
  const dup = await getPool(q, id)
  if (dup) throw new PoolError(`A pool "${id}" already exists (${dup.label}).`, 409)
  const { rows } = await q.query<Pool>(
    `insert into lp.pools (id, label, description, sort, active, created_by) values ($1, $2, $3, $4, $5, $6) returning ${COLS}`,
    [id, label, description, sort, input.active ?? true, actor],
  )
  // Pools are keyed by a text slug, not a number: entity_id stays null, entity_key carries the pool id (0017/v3).
  await q.query(
    `insert into lp.status_history (entity_type, entity_key, field, old_value, new_value, changed_by, via)
     values ('pool', $1, 'created', null, $2, $3, $4)`,
    [id, label, actor, via],
  )
  return rows[0]
}

/**
 * Idempotent create: returns the existing pool when the slug (or the slug the
 * label would produce) already exists, instead of throwing PoolError(409).
 * For a caller that wants "make sure this pool exists" rather than "create a
 * new one" (e.g. an AI-suggested pool from a campaign-profile wizard).
 */
export async function getOrCreatePool(q: Queryable, actor: string, input: CreatePoolInput, via: 'ui' | 'ops_api' = 'ops_api'): Promise<Pool> {
  const id = input.id != null && String(input.id).trim() ? parseSlug(input.id) : slugifyPoolLabel(String(input.label ?? ''))
  const existing = await getPool(q, id)
  if (existing) return existing
  return createPool(q, actor, input, via)
}

export interface UpdatePoolPatch {
  label?: string
  description?: string | null
  sort?: number
  active?: boolean
}

export async function updatePool(q: Queryable, id: string, patch: UpdatePoolPatch, actor = 'owner', via: 'ui' | 'ops_api' = 'ops_api'): Promise<Pool> {
  const cur = await getPool(q, id)
  if (!cur) throw new PoolError(`No pool "${id}".`, 404)
  const label = patch.label === undefined ? cur.label : String(patch.label).trim()
  if (!label || label.length > 80) throw new PoolError('label must be 1-80 characters.')
  const description = patch.description === undefined ? cur.description : patch.description === null || patch.description === '' ? null : String(patch.description).trim().slice(0, 1000)
  const sort = patch.sort === undefined ? cur.sort : Math.trunc(Number(patch.sort))
  if (!Number.isFinite(sort)) throw new PoolError('sort must be a number.')
  const active = patch.active === undefined ? cur.active : Boolean(patch.active)
  const { rows } = await q.query<Pool>(
    `update lp.pools set label = $2, description = $3, sort = $4, active = $5 where id = $1 returning ${COLS}`,
    [cur.id, label, description, sort, active],
  )
  const changes: [string, unknown, unknown][] = [
    ...(label !== cur.label ? [['label', cur.label, label] as [string, unknown, unknown]] : []),
    ...(description !== cur.description ? [['description', cur.description, description] as [string, unknown, unknown]] : []),
    ...(sort !== cur.sort ? [['sort', cur.sort, sort] as [string, unknown, unknown]] : []),
    ...(active !== cur.active ? [['active', cur.active, active] as [string, unknown, unknown]] : []),
  ]
  for (const [field, oldV, newV] of changes) {
    await q.query(
      `insert into lp.status_history (entity_type, entity_key, field, old_value, new_value, changed_by, via)
       values ('pool', $1, $2, $3, $4, $5, $6)`,
      [cur.id, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV), actor, via],
    )
  }
  return rows[0]
}

/**
 * A postgres FK-violation on a pool column (code 23503) -> a plain PoolError.
 * Call this from a catch block around any insert/update that writes a pool
 * slug into campaigns.pool / companies.segment / campaign_meta.segment /
 * rule_sets.segment, instead of validating the value against a fixed list.
 */
export function mapPoolFkError(e: unknown, value: unknown): never | undefined {
  const code = (e as { code?: string } | null)?.code
  const constraint = (e as { constraint?: string } | null)?.constraint
  if (code === '23503' && typeof constraint === 'string' && /_pool_fk|_segment_fk/.test(constraint)) {
    throw new PoolError(`Unknown pool "${String(value)}". Create it first, or pick an existing one.`)
  }
  return undefined
}

/**
 * A tiny cached loader for server components / read-mostly call sites that
 * don't want a round trip on every render. Cache for the process lifetime of
 * the request; call `invalidatePoolsCache()` after any write.
 */
let cache: { at: number; pools: Pool[] } | null = null
const CACHE_MS = 15_000

export async function cachedPools(q: Queryable): Promise<Pool[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.pools
  const pools = await listPools(q)
  cache = { at: now, pools }
  return pools
}

export function invalidatePoolsCache(): void {
  cache = null
}

/** Best-effort label for a pool id without a DB round trip (logs, summaries). Falls back to the id itself. */
export function poolLabelGuess(id: string, known: Pool[] = []): string {
  const hit = known.find((p) => p.id === id)
  if (hit) return hit.label
  return id
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}
