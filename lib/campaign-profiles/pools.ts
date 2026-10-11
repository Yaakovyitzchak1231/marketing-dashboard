/**
 * Pools (industries / audiences) are rows in lp.pools now, not a fixed list
 * (PR #63's second commit: campaigns.pool, companies.segment, campaign_meta.segment
 * and rule_sets.segment are all FKs to lp.pools). This is the one place the
 * campaign-profile wizard reads/creates pools from, so "jeweler" and "ai_agency"
 * are just two rows among whichever ones Yaakov adds — never a hard-coded list.
 */
import type { Db, Queryable } from '../db/types.ts'
import { logEvent } from '../ops/events.ts'
import { ProfileError } from './store.ts'

export interface Pool {
  id: string
  label: string
  description: string | null
  sort: number
  active: boolean
}

export async function listPools(db: Queryable, opts: { include_inactive?: boolean } = {}): Promise<Pool[]> {
  const { rows } = await db.query<Pool>(
    `select id, label, description, sort, active from lp.pools where active or $1 order by sort, label`,
    [opts.include_inactive === true],
  )
  return rows
}

function slugify(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
}

/** Create a new pool (a new industry/audience) for a label the wizard's pool picker doesn't already have. */
export async function createPool(db: Db, actor: string, label: string, opts: { id?: string; description?: string | null } = {}): Promise<Pool> {
  const cleanLabel = label.trim()
  if (!cleanLabel || cleanLabel.length > 80) throw new ProfileError('label must be 1-80 characters.')
  let id = (opts.id ?? slugify(cleanLabel)).trim().toLowerCase()
  if (!id) id = `pool_${Date.now()}`
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(id)) throw new ProfileError('A pool id must start with a letter and contain only lowercase letters, digits and underscores.')
  return db.tx(async (q) => {
    const existing = await q.query<{ id: string; label: string }>('select id, label from lp.pools where id = $1', [id])
    if (existing.rows[0]) return existing.rows[0] as Pool
    const { rows } = await q.query<Pool>(
      `insert into lp.pools (id, label, description, created_by) values ($1, $2, $3, $4) returning id, label, description, sort, active`,
      [id, cleanLabel, opts.description ?? null, actor],
    )
    await logEvent(q, {
      actor,
      kind: 'pool.created',
      summary: `${actor} added "${cleanLabel}" as a new pool (${id})`,
      entity_type: 'pool',
      entity_id: id,
      data: { id, label: cleanLabel },
    })
    return rows[0]
  }, actor)
}

/**
 * Set a campaign's pool directly (bypasses lib/campaigns/store.ts's own
 * updateCampaign, which still validates against a fixed POOLS constant that
 * predates lp.pools becoming a table — see the note in this PR's description).
 * Writes the same lp.status_history shape campaigns.ts writes for other
 * fields, so the campaign's History drawer shows it the same way.
 */
export async function setCampaignPool(db: Db, actor: string, campaignId: number, poolId: string): Promise<{ campaign_id: number; pool: string }> {
  return db.tx(async (q) => {
    const pool = await q.query<{ id: string; label: string }>('select id, label from lp.pools where id = $1 and active', [poolId])
    if (!pool.rows[0]) throw new ProfileError(`No active pool "${poolId}". Create it first.`, 404)
    const before = await q.query<{ pool: string }>('select pool from lp.campaigns where id = $1 for update', [campaignId])
    if (!before.rows[0]) throw new ProfileError(`No campaign ${campaignId}.`, 404)
    const oldPool = before.rows[0].pool
    if (oldPool === poolId) return { campaign_id: campaignId, pool: poolId }
    await q.query('update lp.campaigns set pool = $2, updated_by = $3 where id = $1', [campaignId, poolId, actor])
    await q.query(
      `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via) values ('campaign', $1, 'pool', $2, $3, $4, 'ui')`,
      [campaignId, oldPool, poolId, actor],
    )
    await logEvent(q, {
      actor,
      kind: 'campaign.updated',
      summary: `${actor} set this campaign's pool to ${pool.rows[0].label}`,
      entity_type: 'campaign',
      entity_id: campaignId,
      data: { changes: [{ field: 'pool', from: oldPool, to: poolId }] },
    })
    return { campaign_id: campaignId, pool: poolId }
  }, actor)
}
