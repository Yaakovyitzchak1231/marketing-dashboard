'use server'

/**
 * Buttons on the SEO / AI visibility screens. Each runs as the signed-in
 * owner, logs to Activity, and sends the browser back with a plain message.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { OpsError, updateTask } from '@/lib/ops/core'
import { addCompetitor, addPrompt, addSite, getFixTask, listSites, parsePaths, removeCompetitor, runSiteAudit, runVisibility, setPromptActive, setSiteActive } from '@/lib/seo/store'
import { applyChange, undoChange, type ApplyInput } from '@/lib/seo/changes'
import { visibilitySummary, type ProviderId } from '@/lib/seo/visibility'
import { kickDelivery } from '@/lib/notify/kick'
import { createCitationTask } from '@/lib/seo/citations'

const ME = 'owner'

function db() {
  const d = getDb()
  if (!d) throw new OpsError('The database is not connected (DATABASE_URL is not set).', 412)
  return d
}
const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}
const raw = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v : ''
}
const n = (f: FormData, k: string) => {
  const v = Number(s(f, k))
  return Number.isInteger(v) && v > 0 ? v : null
}

function backTo(f: FormData, fallback: string, params: Record<string, string>): never {
  const r = s(f, 'return_to')
  const path = r.startsWith('/seo') ? r.split('?')[0] : fallback
  const qs = new URLSearchParams(params).toString()
  revalidatePath('/seo', 'layout')
  redirect(`${path}${qs ? `?${qs}` : ''}`)
}

async function attempt(f: FormData, fallback: string, fn: () => Promise<string>): Promise<never> {
  let msg: string
  try {
    msg = await fn()
  } catch (e) {
    if (e && typeof e === 'object' && 'digest' in e) throw e // a redirect from inside fn
    backTo(f, fallback, { err: (e as Error).message.slice(0, 300) })
  }
  kickDelivery(getDb())
  backTo(f, fallback, { ok: msg })
}

export async function addSiteAction(f: FormData) {
  await attempt(f, '/seo/sites', async () => {
    const site = await addSite(db(), ME, {
      name: s(f, 'name'),
      base_url: s(f, 'base_url'),
      platform: s(f, 'platform') || null,
      host: s(f, 'host') || null,
      campaign: s(f, 'campaign') || null,
      pages: parsePaths(s(f, 'pages')),
    })
    return `Tracking ${site.name}. Run its audit when you're ready.`
  })
}

export async function toggleSiteAction(f: FormData) {
  await attempt(f, '/seo/sites', async () => {
    const id = n(f, 'site_id')!
    const active = s(f, 'active') === '1'
    await setSiteActive(db(), ME, id, active)
    return active ? 'Tracking resumed.' : 'Tracking paused.'
  })
}

/** "Re-run audit" and "Done, re-check". site_id = one site; none = every active site. */
export async function runAuditAction(f: FormData) {
  await attempt(f, '/seo/audit', async () => {
    const d = db()
    const id = n(f, 'site_id')
    const ids = id ? [id] : (await listSites(d, { activeOnly: true })).map((x) => x.id)
    const key = process.env.PAGESPEED_API_KEY?.trim() || null
    const parts: string[] = []
    for (const sid of ids) {
      const r = await runSiteAudit(d, ME, sid, { pagespeedKey: key })
      parts.push(`${r.audit.passed} passed, ${r.audit.failed} failed, ${r.audit.warned} to improve${r.fixes.closed ? `, ${r.fixes.closed} fix${r.fixes.closed === 1 ? '' : 'es'} confirmed` : ''}`)
    }
    return ids.length === 1 ? `Audit done: ${parts[0]}.` : `Audited ${ids.length} sites.`
  })
}

export async function runVisibilityAction(f: FormData) {
  await attempt(f, '/seo/visibility', async () => {
    const run = await runVisibility(db(), ME, s(f, 'provider') as ProviderId)
    return `AI answer check: TapDash ${visibilitySummary(run)}.`
  })
}

export async function queueCitationAction(f: FormData) {
  await attempt(f, '/seo/citations', async () => {
    const siteId = n(f, 'site_id'), resultId = n(f, 'result_id')
    const mode = s(f, 'mode')
    if (!siteId || !resultId || (mode !== 'review' && mode !== 'draft')) throw new OpsError('Choose a site, stored answer and review action')
    const task = await createCitationTask(db(), ME, { site_id: siteId, result_id: resultId, mode })
    // Internal fixed target, not a caller-supplied redirect URL.
    f.set('return_to', `/seo/todos/${task.id}`)
    return task.created ? 'Evidence-backed task created. No website changes or external requests were made.' : 'That question already has an open task. Its original evidence was preserved.'
  })
}

export async function addPromptAction(f: FormData) {
  await attempt(f, '/seo/visibility', async () => {
    await addPrompt(db(), ME, s(f, 'prompt'), s(f, 'campaign') || null)
    return 'Question added.'
  })
}

export async function togglePromptAction(f: FormData) {
  await attempt(f, '/seo/visibility', async () => {
    await setPromptActive(db(), ME, n(f, 'prompt_id')!, s(f, 'active') === '1')
    return 'Saved.'
  })
}

export async function addCompetitorAction(f: FormData) {
  await attempt(f, '/seo/visibility', async () => {
    await addCompetitor(db(), ME, s(f, 'name'), s(f, 'domain') || null)
    return 'Competitor added.'
  })
}

export async function removeCompetitorAction(f: FormData) {
  await attempt(f, '/seo/visibility', async () => {
    await removeCompetitor(db(), ME, n(f, 'competitor_id')!)
    return 'Removed.'
  })
}

/** "Assign to" (Tab / Hermes / anyone) and "Mark done" / "Reopen" on a fix. */
export async function updateFixAction(f: FormData) {
  await attempt(f, '/seo/todos', async () => {
    const id = n(f, 'task_id')!
    const t = await getFixTask(db(), id)
    if (!t) throw new OpsError(`fix ${id} not found`, 404)
    const op = s(f, 'op')
    if (op === 'assign') {
      const to = s(f, 'assigned_to') || null
      await updateTask(db(), ME, id, { assigned_to: to, ...(['done', 'cancelled'].includes(t.status) ? { status: 'queued' as const } : {}) })
      return to ? `Assigned to ${to === 'owner' ? 'you' : to}. It's on the Team board.` : 'Unassigned.'
    }
    if (op === 'done') {
      await updateTask(db(), ME, id, { status: 'done' })
      return t.payload.citation_evidence ? 'Marked done. Run a new visibility check to measure mentions and citations; task completion does not prove improvement.' : 'Marked done. The next audit confirms it.'
    }
    if (op === 'reopen') {
      await updateTask(db(), ME, id, { status: 'queued' })
      return 'Reopened.'
    }
    if (op === 'dismiss') {
      await updateTask(db(), ME, id, { status: 'cancelled' })
      return 'Dismissed.'
    }
    throw new OpsError('unknown action')
  })
}

/** Apply a previewed WordPress change (the owner's confirm click). */
export async function applyChangeAction(f: FormData) {
  await attempt(f, '/seo/todos', async () => {
    const kind = s(f, 'kind')
    const siteId = n(f, 'site_id')!
    const taskId = n(f, 'task_id')
    const expect = f.has('expect_before') ? (raw(f, 'expect_before') === '' ? null : raw(f, 'expect_before')) : null
    let input: ApplyInput
    if (kind === 'set_meta') input = { kind, field: s(f, 'field') as 'title' | 'description' | 'canonical', path: s(f, 'path'), value: raw(f, 'value'), expect_before: expect }
    else if (kind === 'add_schema') input = { kind, path: s(f, 'path'), value: raw(f, 'value'), expect_before: expect }
    else if (kind === 'hide_page') input = { kind, path: s(f, 'path'), mode: s(f, 'mode') === 'draft' ? 'draft' : 'noindex' }
    else if (kind === 'create_draft') input = { kind, title: s(f, 'title'), slug: s(f, 'slug'), content: raw(f, 'content') }
    else throw new OpsError('unknown change')
    const c = await applyChange(db(), ME, siteId, taskId, input)
    return `Applied (change #${c.id}). Undo is below if you need it.`
  })
}

export async function undoChangeAction(f: FormData) {
  await attempt(f, '/seo/todos', async () => {
    const c = await undoChange(db(), ME, n(f, 'change_id')!)
    return `Undid change #${c.id}.`
  })
}
