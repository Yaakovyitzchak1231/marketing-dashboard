'use server'

/**
 * Jobs screen, from the dashboard. Owner-only (plan 1.14, Viktor's #87
 * re-review): an ops_call job runs any op through /api/ops with the runner's
 * own key, so saving, switching on or running a job is owner power. Each
 * action checks the role itself (actorFor) and writes as the signed-in owner.
 * The same functions agents reach through /api/ops (lib/jobs/ops.ts). A bad
 * input comes back to the page as ?error=... instead of an error screen.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { OpsError } from '@/lib/ops/core'
import { runNow, setEnabled, upsertJob } from '@/lib/jobs/store'
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

async function guarded(fn: () => Promise<void>) {
  try {
    await fn()
  } catch (e) {
    if (e instanceof OpsError || e instanceof AuthError) redirect(`/jobs?error=${encodeURIComponent(e.message)}`)
    throw e
  }
  revalidatePath('/jobs')
  redirect('/jobs')
}

export async function saveJobAction(f: FormData) {
  await guarded(async () => {
    const ME = await actorFor('owner')
    const campaignRaw = s(f, 'campaign_id')
    await upsertJob(db(), ME, {
      name: s(f, 'name'),
      kind: s(f, 'kind'),
      description: s(f, 'description') || null,
      schedule_cron: s(f, 'schedule_cron') || null,
      timezone: s(f, 'timezone') || undefined,
      campaign_id: campaignRaw ? Number(campaignRaw) : null,
      payload: (() => {
        const raw = s(f, 'payload')
        if (!raw) return {}
        try {
          return JSON.parse(raw)
        } catch {
          throw new OpsError('Payload must be valid JSON (an object).')
        }
      })(),
      enabled: s(f, 'enabled') === 'on',
      timeout_s: s(f, 'timeout_s') ? Number(s(f, 'timeout_s')) : undefined,
      via: 'ui',
    })
  })
}

export async function toggleJobAction(f: FormData) {
  await guarded(async () => {
    const ME = await actorFor('owner')
    const name = s(f, 'name')
    const enabled = s(f, 'enabled') === 'true'
    await setEnabled(db(), ME, name, enabled, 'ui')
  })
}

export async function runJobNowAction(f: FormData) {
  await guarded(async () => {
    const ME = await actorFor('owner')
    await runNow(db(), ME, s(f, 'name'))
  })
}
