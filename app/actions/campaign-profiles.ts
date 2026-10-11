'use server'

/**
 * Campaign profiles, from the dashboard (the signed-in person, editor or owner, recorded by their own actor id). The
 * same functions agents reach through /api/ops (lib/campaign-profiles/ops.ts).
 * Every action answers {ok, ...} instead of throwing, so the wizard can show
 * a plain error line without a crash screen.
 */
import { actorFor } from '@/lib/auth/act'
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/db'
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
  type CopyResult,
  type ItemInput,
  type ItemKind,
  type ItemStatus,
  type ProfileItem,
  type ProfilePatch,
  type ProfileWithItems,
} from '@/lib/campaign-profiles/store'
import { getAiConfig, suggestCampaignProfile, verifyFeed, type SuggestOutcome } from '@/lib/campaign-profiles/suggest'
import { verifyItem } from '@/lib/campaign-profiles/verify'
import { getOrCreatePool, listPools, PoolError, type Pool } from '@/lib/pools/store'

type Fail = { ok: false; error: string }

function db() {
  const d = getDb()
  if (!d) throw new ProfileError('The lead database is not connected (DATABASE_URL is not set).')
  return d
}

function fail(e: unknown): Fail {
  if (e instanceof ProfileError || e instanceof PoolError) return { ok: false, error: e.message }
  console.error('campaign profile action failed', (e as Error).message)
  return { ok: false, error: 'That could not be saved right now.' }
}

function touch(campaignId: number) {
  revalidatePath(`/campaigns/${campaignId}`)
  revalidatePath(`/campaigns/${campaignId}/profile`)
}

export async function getProfileAction(campaignId: number): Promise<{ ok: true; data: ProfileWithItems } | Fail> {
  try {
    return { ok: true, data: await getProfile(db(), campaignId) }
  } catch (e) {
    return fail(e)
  }
}

export async function updateProfileAction(campaignId: number, patch: ProfilePatch): Promise<{ ok: true; data: ProfileWithItems['profile'] } | Fail> {
  const who = await actorFor('editor').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (who instanceof Error) return { ok: false, error: who.message }
  const ME = who
  try {
    const data = await upsertProfile(db(), ME, campaignId, patch)
    touch(campaignId)
    return { ok: true, data }
  } catch (e) {
    return fail(e)
  }
}

export async function addProfileItemsAction(campaignId: number, items: ItemInput[]): Promise<{ ok: true; added: ProfileItem[]; already: { kind: ItemKind; name: string }[] } | Fail> {
  const who = await actorFor('editor').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (who instanceof Error) return { ok: false, error: who.message }
  const ME = who
  try {
    const r = await addItems(db(), ME, campaignId, items, 'ui')
    touch(campaignId)
    return { ok: true, added: r.added, already: r.already }
  } catch (e) {
    return fail(e)
  }
}

export async function setItemStatusAction(ids: number[], status: ItemStatus, campaignId: number): Promise<{ ok: true; items: ProfileItem[] } | Fail> {
  const who = await actorFor('editor').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (who instanceof Error) return { ok: false, error: who.message }
  const ME = who
  try {
    const items = await setItemStatus(db(), ME, ids, status, 'ui')
    touch(campaignId)
    return { ok: true, items }
  } catch (e) {
    return fail(e)
  }
}

export async function updateProfileItemAction(id: number, patch: { name?: string; value?: string | null; config?: Record<string, unknown>; rationale?: string | null; sort?: number }, campaignId: number): Promise<{ ok: true; item: ProfileItem } | Fail> {
  const who = await actorFor('editor').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (who instanceof Error) return { ok: false, error: who.message }
  const ME = who
  try {
    const item = await updateItem(db(), ME, id, patch)
    touch(campaignId)
    return { ok: true, item }
  } catch (e) {
    return fail(e)
  }
}

export async function suggestProfileAction(campaignId: number, industry: string, notes?: string | null, exampleSites?: string[]): Promise<{ ok: true; result: SuggestOutcome } | Fail> {
  const who = await actorFor('editor').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (who instanceof Error) return { ok: false, error: who.message }
  const ME = who
  try {
    const result = await suggestCampaignProfile(db(), ME, { campaign_id: campaignId, industry, notes: notes ?? null, example_sites: exampleSites })
    touch(campaignId)
    return { ok: true, result }
  } catch (e) {
    return fail(e)
  }
}

export async function aiConfiguredAction(): Promise<{ ok: true; configured: boolean }> {
  return { ok: true, configured: getAiConfig() !== null }
}

export async function verifyFeedAction(url: string): Promise<{ ok: true; result: Awaited<ReturnType<typeof verifyFeed>> } | Fail> {
  try {
    return { ok: true, result: await verifyFeed(url) }
  } catch (e) {
    return fail(e)
  }
}

export async function copyProfileAction(fromCampaignId: number, toCampaignId: number): Promise<{ ok: true; data: CopyResult } | Fail> {
  const who = await actorFor('editor').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (who instanceof Error) return { ok: false, error: who.message }
  const ME = who
  try {
    const data = await copyProfile(db(), ME, fromCampaignId, toCampaignId)
    touch(toCampaignId)
    return { ok: true, data }
  } catch (e) {
    return fail(e)
  }
}

export async function approvedItemsAction(campaignId: number, kind: ItemKind): Promise<{ ok: true; items: ProfileItem[] } | Fail> {
  try {
    return { ok: true, items: await approvedItems(db(), campaignId, kind) }
  } catch (e) {
    return fail(e)
  }
}

export async function listPoolsAction(): Promise<{ ok: true; pools: Pool[] } | Fail> {
  try {
    return { ok: true, pools: await listPools(db()) }
  } catch (e) {
    return fail(e)
  }
}

export async function createPoolAction(label: string): Promise<{ ok: true; pool: Pool } | Fail> {
  const who = await actorFor('editor').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (who instanceof Error) return { ok: false, error: who.message }
  const ME = who
  try {
    return { ok: true, pool: await getOrCreatePool(db(), ME, { label }, 'ui') }
  } catch (e) {
    return fail(e)
  }
}

export async function recheckProfileItemAction(itemId: number, campaignId: number): Promise<{ ok: true; item: ProfileItem } | Fail> {
  const who = await actorFor('editor').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (who instanceof Error) return { ok: false, error: who.message }
  const ME = who
  try {
    const { rows } = await db().query<Record<string, unknown>>(`select id, kind, name, value, config from lp.campaign_profile_items where id = $1`, [itemId])
    if (!rows[0]) throw new ProfileError(`No profile item ${itemId}.`, 404)
    const outcome = await verifyItem({ kind: rows[0].kind as never, name: rows[0].name as string, value: rows[0].value as string | null, config: rows[0].config as Record<string, unknown> })
    const item = await setItemVerify(db(), ME, itemId, { status: outcome.status, detail: outcome.detail })
    touch(campaignId)
    return { ok: true, item }
  } catch (e) {
    return fail(e)
  }
}
