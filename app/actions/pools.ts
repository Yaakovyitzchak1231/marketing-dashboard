'use server'

/**
 * The /settings/pools page's buttons. Pools are rows in lp.pools (migration
 * 0020), not a hard-coded list: creating or editing one is an owner's call
 * (same rule as the ops API's create_pool / update_pool, which require a
 * human actor). Each action checks the role itself (actorFor) and writes as
 * the signed-in person, so the audit trail names who really did it.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { actorFor } from '@/lib/auth/act'
import { currentRole } from '@/lib/auth/session'
import { AuthError } from '@/lib/auth/roles'
import { createPool, invalidatePoolsCache, PoolError, updatePool } from '@/lib/pools/store'

function db() {
  const d = getDb()
  if (!d) throw new Error('The lead database is not connected (DATABASE_URL is not set).')
  return d
}
const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}
const msg = (e: unknown) => (e instanceof AuthError ? e.message : e instanceof PoolError ? e.message : null)

function back(q: Record<string, string>): never {
  const u = new URLSearchParams(q)
  redirect(`/settings/pools?${u.toString()}`)
}

export async function poolsPageRole(): Promise<{ isOwner: boolean }> {
  // Read used by the pools page (viewers included) to hide owner-only buttons.
  await actorFor('viewer')
  return { isOwner: (await currentRole()) === 'owner' }
}

export async function createPoolAction(f: FormData) {
  try {
    const me = await actorFor('owner')
    const sortRaw = s(f, 'sort')
    const pool = await createPool(
      db(),
      me,
      {
        id: s(f, 'id') || undefined,
        label: s(f, 'label'),
        description: s(f, 'description') || null,
        sort: sortRaw ? Number(sortRaw) : undefined,
      },
      'ui',
    )
    invalidatePoolsCache()
    revalidatePath('/settings/pools')
    back({ saved: `Pool "${pool.label}" created.` })
  } catch (e) {
    const m = msg(e)
    if (m) back({ error: m })
    throw e
  }
}

export async function updatePoolAction(f: FormData) {
  try {
    const me = await actorFor('owner')
    const id = s(f, 'id')
    if (!id) back({ error: 'Pool id is missing.' })
    const sortRaw = s(f, 'sort')
    const pool = await updatePool(
      db(),
      id,
      {
        label: s(f, 'label'),
        description: s(f, 'description') || null,
        sort: sortRaw ? Number(sortRaw) : 100,
        active: s(f, 'active') === 'on',
      },
      me,
      'ui',
    )
    invalidatePoolsCache()
    revalidatePath('/settings/pools')
    back({ saved: `Pool "${pool.label}" updated.` })
  } catch (e) {
    const m = msg(e)
    if (m) back({ error: m })
    throw e
  }
}
