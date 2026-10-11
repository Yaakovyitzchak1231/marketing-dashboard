'use server'

/**
 * Server actions behind /settings: saving a non-secret value, replacing or
 * clearing a secret, testing a secret against its provider, and editing which
 * task kinds an agent takes. Settings, keys and the team are owner-only
 * (plan 1.14); every write runs as the signed-in human's own actor id, so
 * the audit log names who actually made the change.
 */
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/db'
import { OpsError } from '@/lib/ops/core'
import { currentActorId, currentRole } from '@/lib/auth/session'
import { requireRole } from '@/lib/auth/roles'
import {
  clearSecret,
  listActorKinds,
  putSecret,
  putSetting,
  secretStatus,
  setActorTakesKinds,
  SettingsError,
  type ActorKindsRow,
  type SecretStatus,
} from '@/lib/settings/store'
import { settingSpec } from '@/lib/settings/registry'
import { clientFromConfig } from '@/lib/instantly/client'

export interface FormResult {
  ok: boolean
  message?: string
}

function db() {
  const d = getDb()
  if (!d) throw new Error('The lead database is not connected (DATABASE_URL is not set).')
  return d
}
const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v : ''
}
const fail = (e: unknown): FormResult => ({
  ok: false,
  message: e instanceof SettingsError || e instanceof OpsError ? e.message : 'That did not work: ' + (e as Error).message,
})

export async function saveSettingAction(_prev: FormResult | null, f: FormData): Promise<FormResult> {
  const key = s(f, 'key')
  try {
    requireRole(await currentRole(), 'owner')
    await putSetting(db(), await currentActorId(), key, s(f, 'value'), { via: 'ui' })
    revalidatePath('/settings')
    return { ok: true, message: 'Saved.' }
  } catch (e) {
    return fail(e)
  }
}

export async function replaceSecretAction(_prev: FormResult | null, f: FormData): Promise<FormResult> {
  const key = s(f, 'key')
  try {
    requireRole(await currentRole(), 'owner')
    const row = await putSecret(db(), await currentActorId(), key, s(f, 'value'), { via: 'ui' })
    revalidatePath('/settings')
    return { ok: true, message: `Saved — ends in …${row.last4}.` }
  } catch (e) {
    return fail(e)
  }
}

export async function clearSecretAction(f: FormData) {
  const key = s(f, 'key')
  if (s(f, 'confirm') !== 'yes') return
  requireRole(await currentRole(), 'owner')
  await clearSecret(db(), await currentActorId(), key, { via: 'ui' })
  revalidatePath('/settings')
}

/** Runs the registry's test() for one secret and reports plain words; never echoes the value. */
export async function testSecretAction(_prev: FormResult | null, f: FormData): Promise<FormResult> {
  const key = s(f, 'key')
  try {
    requireRole(await currentRole(), 'owner')
  } catch (e) {
    return fail(e)
  }
  const spec = settingSpec(key)
  if (!spec) return { ok: false, message: `Unknown setting "${key}".` }
  const status: SecretStatus = await secretStatus(db(), key)
  if (!status.set) return { ok: false, message: 'Nothing saved yet to test.' }
  try {
    if (key === 'instantly.api_key') {
      const client = await clientFromConfig()
      if (!client) return { ok: false, message: 'Not configured.' }
      await client.get('/campaigns', { limit: 1 })
      return { ok: true, message: 'Instantly accepted the key.' }
    }
    return { ok: false, message: 'No test is wired up for this one yet.' }
  } catch (e) {
    return { ok: false, message: (e as Error).message.slice(0, 300) }
  }
}

export async function setAgentTakesKindsAction(_prev: FormResult | null, f: FormData): Promise<FormResult> {
  const actorId = s(f, 'actor_id')
  const kinds = s(f, 'takes_kinds')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
  try {
    requireRole(await currentRole(), 'owner')
    const row: ActorKindsRow = await setActorTakesKinds(db(), await currentActorId(), actorId, kinds, { via: 'ui' })
    revalidatePath('/settings')
    return { ok: true, message: row.takes_kinds.length ? `Takes: ${row.takes_kinds.join(', ')}.` : 'Takes any kind.' }
  } catch (e) {
    return fail(e)
  }
}

export async function listActorKindsForSettings() {
  return listActorKinds(db())
}
