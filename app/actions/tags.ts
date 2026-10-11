'use server'

/**
 * The /settings/tags page's buttons. Always acts as 'owner' (the signed-in
 * human; middleware.ts gates server actions behind login).
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { actorFor } from '@/lib/auth/act'
import { AuthError } from '@/lib/auth/roles'
import { TagError, mergeTags, renameTag, setTagStyle } from '@/lib/tags/store'

function db() {
  const d = getDb()
  if (!d) throw new Error('The lead database is not connected (DATABASE_URL is not set).')
  return d
}
const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}
const msg = (e: unknown) => (e instanceof AuthError ? e.message : e instanceof TagError ? e.message : null)

function back(q: Record<string, string>): never {
  const u = new URLSearchParams(q)
  redirect(`/settings/tags?${u.toString()}`)
}

export async function renameTagAction(f: FormData) {
  try {
    const ME = await actorFor('owner')
    await renameTag(db(), ME, { from: s(f, 'from'), to: s(f, 'to') })
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  revalidatePath('/settings/tags')
  back({ saved: 'Renamed.' })
}

export async function mergeTagsAction(f: FormData) {
  try {
    const ME = await actorFor('owner')
    const tags = s(f, 'tags').split(',').map((t) => t.trim()).filter(Boolean)
    await mergeTags(db(), ME, { tags, into: s(f, 'into') })
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  revalidatePath('/settings/tags')
  back({ saved: 'Merged.' })
}

export async function setTagStyleAction(f: FormData) {
  try {
    const ME = await actorFor('owner')
    await setTagStyle(db(), ME, { tag: s(f, 'tag'), colour: s(f, 'colour') || null, description: s(f, 'description') || null })
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  revalidatePath('/settings/tags')
  back({ saved: 'Saved.' })
}
