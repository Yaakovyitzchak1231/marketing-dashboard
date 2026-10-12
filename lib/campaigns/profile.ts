/**
 * The reader later features call (plan 1.16). Monitors, the digest and the
 * REST route use this — not the wizard's full draft, which also includes
 * suggested and rejected items.
 *
 * Competitors are rows in lp.campaign_profile_items (kind 'competitor').
 * There is no separate competitor registry.
 */
import type { Queryable } from '../db/types.ts'
import {
  ProfileError,
  getProfile,
  ITEM_KINDS,
  type ItemKind,
  type ProfileItem,
  type ProfileWithItems,
} from '../campaign-profiles/store.ts'

export interface CampaignProfileView {
  campaign_id: number
  campaign_name: string
  campaign_status: string
  exists: boolean
  profile: ProfileWithItems['profile']
  /** Approved items only, grouped by kind. Empty lists for kinds with none. */
  items: Record<ItemKind, ProfileItem[]>
}

function approvedOnly(items: Record<ItemKind, ProfileItem[]>): Record<ItemKind, ProfileItem[]> {
  const out = {} as Record<ItemKind, ProfileItem[]>
  for (const k of ITEM_KINDS) out[k] = items[k].filter((it) => it.status === 'approved')
  return out
}

/** One campaign's profile. Creates nothing. 404 if the campaign does not exist. */
export async function profileFor(db: Queryable, campaignId: number): Promise<CampaignProfileView> {
  const c = await db.query<{ id: number; name: string; status: string }>('select id, name, status from lp.campaigns where id = $1', [campaignId])
  if (!c.rows[0]) throw new ProfileError(`No campaign ${campaignId}.`, 404)
  const got = await getProfile(db, campaignId)
  return {
    campaign_id: campaignId,
    campaign_name: c.rows[0].name,
    campaign_status: c.rows[0].status,
    exists: got.exists,
    profile: got.profile,
    items: approvedOnly(got.items),
  }
}

/**
 * Profiles marked active (setup_status 'active') on campaigns that are not
 * archived. A paused campaign with an active profile is included; an archived
 * campaign is not. Creates nothing.
 */
export async function activeProfiles(db: Queryable): Promise<CampaignProfileView[]> {
  const { rows } = await db.query<{ id: number }>(
    `select c.id
       from lp.campaigns c
       join lp.campaign_statuses s on s.id = c.status
       join lp.campaign_profiles p on p.campaign_id = c.id
      where p.setup_status = 'active' and not s.is_archived
      order by c.id
      limit 500`,
  )
  const out: CampaignProfileView[] = []
  for (const r of rows) out.push(await profileFor(db, Number(r.id)))
  return out
}
