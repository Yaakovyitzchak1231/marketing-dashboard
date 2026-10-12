'use server'

/**
 * The /settings/event-types page's forms. Editor or Owner (the same bar a
 * human's ops key needs for register_event_type / update_event_type — see
 * lib/ops/actor-role.ts). Writes go through lib/events/types-store.ts, which
 * leaves the lp.events audit row.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { actorFor } from '@/lib/auth/act'
import { AuthError } from '@/lib/auth/roles'
import { EventTypeError, registerEventType, updateEventType } from '@/lib/events/types-store'

function db() {
  const d = getDb()
  // A refusal the page can show, not a 500: fail() turns EventTypeError into the error banner.
  if (!d) throw new EventTypeError('The lead database is not connected (DATABASE_URL is not set).', 503)
  return d
}
const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}
function back(q: Record<string, string>): never {
  redirect(`/settings/event-types?${new URLSearchParams(q).toString()}`)
}
function fail(e: unknown): never {
  if (e instanceof AuthError || e instanceof EventTypeError) back({ error: e.message })
  throw e
}

export async function registerEventTypeAction(f: FormData) {
  let msg = ''
  try {
    const ME = await actorFor('editor')
    const row = await db().tx((q) => registerEventType(q, ME, { key: s(f, 'key'), label: s(f, 'label'), category: s(f, 'category'), source: 'dashboard' }), ME)
    msg = row.unchanged ? `${row.key} is already registered exactly like that; nothing changed.` : row.relabeled ? `Relabeled ${row.key}.` : `Registered ${row.key}.`
  } catch (e) {
    fail(e)
  }
  revalidatePath('/settings/event-types')
  back({ saved: msg })
}

export async function updateEventTypeAction(f: FormData) {
  const key = s(f, 'key')
  let changed = true
  try {
    const ME = await actorFor('editor')
    const row = await db().tx((q) => updateEventType(q, ME, key, { label: s(f, 'label'), category: s(f, 'category') }), ME)
    changed = !row.unchanged
  } catch (e) {
    fail(e)
  }
  revalidatePath('/settings/event-types')
  back({ saved: changed ? `Saved ${key}.` : `No changes to ${key}.` })
}

export async function setEventTypeActiveAction(f: FormData) {
  const key = s(f, 'key')
  const active = s(f, 'active') === 'true'
  try {
    const ME = await actorFor('editor')
    await db().tx((q) => updateEventType(q, ME, key, { active }), ME)
  } catch (e) {
    fail(e)
  }
  revalidatePath('/settings/event-types')
  back({ saved: `${active ? 'Activated' : 'Deactivated'} ${key}.` })
}
