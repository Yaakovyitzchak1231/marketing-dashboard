'use server'

/**
 * Tools hub, from the dashboard. Owner-only (plan 1.14): checked here
 * (actorFor) and written as the signed-in owner's own actor id. The same
 * store functions the OVH runner and other agents reach through
 * /api/ops (lib/integrations/ops.ts). A bad input comes back to the page as
 * ?error=… instead of an error screen.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { IntegrationError, upsertIntegration, type IntegrationPatch, type ReachableFrom, type Visibility } from '@/lib/integrations/store'
import { actorFor } from '@/lib/auth/act'
import { AuthError } from '@/lib/auth/roles'

function db() {
  const d = getDb()
  if (!d) throw new Error('The lead database is not connected (DATABASE_URL is not set).')
  return d
}

const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}

async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof IntegrationError || e instanceof AuthError) redirect(`/tools?error=${encodeURIComponent(e.message)}`)
    throw e
  }
  revalidatePath('/tools')
  redirect('/tools')
}

export async function upsertIntegrationAction(f: FormData) {
  await guarded(async () => {
    const ME = await actorFor('owner')
    const id = s(f, 'id') || s(f, 'id_new')
    if (!id) throw new IntegrationError('id is required')
    const patch: IntegrationPatch = {
      name: s(f, 'name'),
      kind: s(f, 'kind'),
      description: s(f, 'description') || null,
      url: s(f, 'url') || null,
      api_url: s(f, 'api_url') || null,
      reachable_from: (s(f, 'reachable_from') || 'public') as ReachableFrom,
      settings_prefix: `integrations.${id}`,
      visibility: (s(f, 'visibility') || 'owner') as Visibility,
      sort: Number(s(f, 'sort')) || 100,
      active: f.get('active') === 'on',
    }
    await db().tx((q) => upsertIntegration(q, ME, id, patch, { via: 'ui' }), ME)
  })
}
