'use server'

/**
 * The /settings/tags page's buttons. Each checks the role itself (actorFor)
 * and writes as the signed-in person. Changing a tag on chosen leads needs
 * editor (at most EDITOR_TAG_CHANGE_CAP leads; owners are not capped);
 * renaming / merging a tag on every lead, and styling, need owner.
 * Every many-lead change goes through a confirm step showing the count.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { actorFor } from '@/lib/auth/act'
import { currentRole } from '@/lib/auth/session'
import { AuthError } from '@/lib/auth/roles'
import { EDITOR_TAG_CHANGE_CAP, TagError, changeTagOnLeads, editorCapMessage, countLeadsWithAnyTag, mergeTags, previewTagChange, renameTag, setTagStyle } from '@/lib/tags/store'

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

/** Read the "which leads" part of a tag-change form: one lead, selected leads, or a segment. */
function scopeFrom(f: FormData): { company_id?: number; company_ids?: number[]; segment_id?: number; mode: string; target: string } {
  const mode = s(f, 'mode')
  const target = s(f, 'target')
  if (mode === 'one') return { company_id: Number(target), mode, target }
  if (mode === 'selected') {
    const ids = target.split(/[\s,]+/).filter(Boolean).map(Number)
    return { company_ids: ids, mode, target }
  }
  if (mode === 'segment') return { segment_id: Number(target), mode, target }
  throw new TagError('Pick which leads: one lead, selected leads, or a segment.')
}

/**
 * Step 1 of changing a tag on chosen leads (editor or owner): count the leads
 * it would change and send the user to a confirm step showing that number.
 * Nothing changes yet. A single lead skips the confirm.
 */
export async function previewTagChangeAction(f: FormData) {
  let q: Record<string, string>
  try {
    const ME = await actorFor('editor')
    const isOwner = (await currentRole()) === 'owner'
    const scope = scopeFrom(f)
    const from = s(f, 'from')
    const to = s(f, 'to')
    if (scope.mode === 'one') {
      await changeTagOnLeads(db(), ME, { from, to, company_id: scope.company_id, via: 'ui' }, { isOwner })
      revalidatePath('/settings/tags')
      q = { saved: `Changed "${from}" to "${to}" on lead #${scope.target}.` }
    } else {
      const p = await previewTagChange(db(), { from, company_ids: scope.company_ids, segment_id: scope.segment_id })
      // Refuse at the preview, so nobody is asked to confirm a change that would be refused.
      if (!isOwner && p.count > EDITOR_TAG_CHANGE_CAP) throw new TagError(editorCapMessage(p.count), 403)
      q = { confirm: 'change', from, to, mode: scope.mode, target: scope.target, count: String(p.count), scope: p.scope }
    }
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  back(q)
}

/** Step 2: the user confirmed the count. Refused if the count has moved since. */
export async function changeTagAction(f: FormData) {
  let done = 0
  try {
    const ME = await actorFor('editor')
    const isOwner = (await currentRole()) === 'owner'
    const scope = scopeFrom(f)
    const r = await changeTagOnLeads(db(), ME, {
      from: s(f, 'from'),
      to: s(f, 'to'),
      company_ids: scope.company_ids,
      segment_id: scope.segment_id,
      company_id: scope.company_id,
      expected_count: Number(s(f, 'expected_count')),
      via: 'ui',
    }, { isOwner })
    done = r.companies_updated
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  revalidatePath('/settings/tags')
  back({ saved: `Changed on ${done} lead${done === 1 ? '' : 's'}.` })
}

/**
 * Rename a tag on EVERY lead: owner only, and always through a confirm step
 * that shows how many leads it changes (first submit counts, second applies
 * with that count).
 */
export async function renameTagAction(f: FormData) {
  let after: Record<string, string> = {}
  try {
    const ME = await actorFor('owner')
    const from = s(f, 'from')
    const to = s(f, 'to')
    const expected = s(f, 'expected_count')
    if (!expected) {
      const count = await countLeadsWithAnyTag(db(), [from])
      after = { confirm: 'rename', from, to, count: String(count) }
    } else {
      const r = await renameTag(db(), ME, { from, to, expected_count: Number(expected), via: 'ui' })
      revalidatePath('/settings/tags')
      after = { saved: `Renamed on all ${r.companies_updated} lead${r.companies_updated === 1 ? '' : 's'}.` }
    }
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  back(after)
}

/** Merge tags on every lead: owner only, with the same count-confirm step. */
export async function mergeTagsAction(f: FormData) {
  let after: Record<string, string> = {}
  try {
    const ME = await actorFor('owner')
    const raw = s(f, 'tags')
    const tags = raw.split(',').map((t) => t.trim()).filter(Boolean)
    const into = s(f, 'into')
    const expected = s(f, 'expected_count')
    if (!expected) {
      if (!tags.length) throw new TagError('List at least one tag to merge.')
      const count = await countLeadsWithAnyTag(db(), tags.filter((t) => t !== into))
      after = { confirm: 'merge', tags: raw, into, count: String(count) }
    } else {
      const r = await mergeTags(db(), ME, { tags, into, expected_count: Number(expected), via: 'ui' })
      revalidatePath('/settings/tags')
      after = { saved: `Merged on ${r.companies_updated} lead${r.companies_updated === 1 ? '' : 's'}.` }
    }
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  back(after)
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
