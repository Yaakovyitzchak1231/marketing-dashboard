'use server'

/** The /settings/fields page's buttons (plan item 1.7). Always acts as the
 *  signed-in human ('owner'), via 'ui'. */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { actorFor } from '@/lib/auth/act'
import { AuthError } from '@/lib/auth/roles'
import { FieldError, archiveField, defineField, updateField } from '@/lib/fields/store'

function db() {
  const d = getDb()
  if (!d) throw new Error('The lead database is not connected (DATABASE_URL is not set).')
  return d
}
const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}
const msg = (e: unknown) => (e instanceof AuthError ? e.message : e instanceof FieldError ? e.message : null)

function back(q: Record<string, string>): never {
  const u = new URLSearchParams(q)
  redirect(`/settings/fields?${u.toString()}`)
}

export async function defineFieldAction(f: FormData) {
  try {
    const ME = await actorFor('owner')
    const optionsRaw = s(f, 'options')
    await defineField(db(), ME, {
      entity: s(f, 'entity'),
      key: s(f, 'key'),
      label: s(f, 'label'),
      type: s(f, 'type'),
      options: optionsRaw ? optionsRaw.split(',').map((o) => o.trim()).filter(Boolean) : undefined,
      campaign_id: s(f, 'campaign_id') || null,
      via: 'ui',
    })
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  revalidatePath('/settings/fields')
  back({ saved: 'Field added.' })
}

export async function archiveFieldAction(f: FormData) {
  try {
    const ME = await actorFor('owner')
    await archiveField(db(), ME, { id: Number(s(f, 'id')), via: 'ui' })
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  revalidatePath('/settings/fields')
  back({ saved: 'Archived.' })
}

export async function updateFieldAction(f: FormData) {
  try {
    const ME = await actorFor('owner')
    const optionsRaw = s(f, 'options')
    await updateField(db(), ME, {
      id: Number(s(f, 'id')),
      label: s(f, 'label') || undefined,
      options: optionsRaw ? optionsRaw.split(',').map((o) => o.trim()).filter(Boolean) : undefined,
      via: 'ui',
    })
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  revalidatePath('/settings/fields')
  back({ saved: 'Updated.' })
}
