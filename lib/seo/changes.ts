import { createHash } from 'node:crypto'
import type { Db, Queryable } from '@/lib/db/types'
import { logEvent } from '@/lib/ops/events'
import { addComment, OpsError, updateTask, requireRunnableActor } from '@/lib/ops/core'
import { getFixTask, getSite } from './store'
import { JSONLD_META, snippetInstalled, WpClient, wpConfigFromEnv, wpMatchesSite, YOAST_META, type WpConfig, type WpFetch, type WpPage } from './wordpress'

/**
 * Apply a fix to WordPress after the owner's click, store before/after, and
 * undo on request. The preview the owner saw is re-checked at apply time: if
 * the live value changed since the preview, nothing is written.
 */

export interface ChangeRow {
  id: number
  site_id: number
  task_id: number | null
  kind: string
  target: string
  wp_id: number | null
  status: 'applying' | 'applied' | 'unknown' | 'undoing' | 'undo_unknown' | 'undone' | 'failed'
  resource_key: string | null
  input_key: string | null
  created_at: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  error: string | null
  applied_by: string | null
  applied_at: string | null
  undone_by: string | null
  undone_at: string | null
}

export type ApplyInput =
  | { kind: 'set_meta'; field: 'title' | 'description' | 'canonical'; path: string; value: string; expect_before: string | null }
  | { kind: 'add_schema'; path: string; value: string; expect_before: string | null }
  | { kind: 'hide_page'; path: string; mode: 'noindex' | 'draft' }
  | { kind: 'create_draft'; title: string; slug: string; content: string }

export interface ApplyEnv {
  cfg?: WpConfig | null
  fetcher?: WpFetch
}

function client(env: ApplyEnv, baseUrl: string): WpClient {
  const cfg = env.cfg === undefined ? wpConfigFromEnv() : env.cfg
  if (!cfg) throw new OpsError('WordPress is not connected: add WP_SITE_URL, WP_USER and WP_APP_PASSWORD.', 412)
  if (!wpMatchesSite(cfg, baseUrl)) throw new OpsError(`WP_SITE_URL is ${cfg.siteUrl}, not this site (${baseUrl}).`, 412)
  return new WpClient(cfg, env.fetcher)
}

const metaStr = (p: WpPage, key: string): string | null => {
  const v = p.meta?.[key]
  return typeof v === 'string' && v !== '' ? v : null
}

/** Validate JSON-LD before it can reach the site. */
export function validateJsonLd(value: string): string {
  let j: unknown
  try {
    j = JSON.parse(value)
  } catch (e) {
    throw new OpsError(`That isn't valid JSON: ${(e as Error).message}`)
  }
  if (!j || typeof j !== 'object' || !('@type' in (j as object) || Array.isArray(j))) throw new OpsError('JSON-LD needs an "@type" (e.g. FAQPage, Service).')
  if (/EDIT:/.test(value)) throw new OpsError('Fill in the EDIT: placeholders first.')
  return JSON.stringify(j)
}

async function pageAt(wp: WpClient, path: string): Promise<WpPage> {
  const p = await wp.findByPath(path)
  if (!p) throw new OpsError(`No WordPress page found at ${path}.`, 404)
  return p
}

/** What the change would do, read live from WordPress (for the preview/diff). */
export async function previewChange(db: Queryable, siteId: number, input: ApplyInput, env: ApplyEnv = {}): Promise<{ before: string | null; after: string; target: string; needsSnippet: boolean; page: WpPage | null }> {
  const site = await getSite(db, siteId)
  if (!site) throw new OpsError(`site ${siteId} not found`, 404)
  const wp = client(env, site.base_url)
  switch (input.kind) {
    case 'set_meta': {
      const p = await pageAt(wp, input.path)
      return { before: metaStr(p, YOAST_META[input.field]), after: input.value.trim(), target: `page ${p.id} ${input.path}`, needsSnippet: !snippetInstalled(p), page: p }
    }
    case 'add_schema': {
      const p = await pageAt(wp, input.path)
      return { before: metaStr(p, JSONLD_META), after: input.value.trim(), target: `page ${p.id} ${input.path}`, needsSnippet: !snippetInstalled(p), page: p }
    }
    case 'hide_page': {
      const p = await pageAt(wp, input.path)
      return input.mode === 'draft'
        ? { before: `status: ${p.status}`, after: 'status: draft', target: `page ${p.id} ${input.path}`, needsSnippet: false, page: p }
        : { before: `noindex: ${metaStr(p, YOAST_META.noindex) === '1' ? 'yes' : 'no'}`, after: 'noindex: yes', target: `page ${p.id} ${input.path}`, needsSnippet: !snippetInstalled(p), page: p }
    }
    case 'create_draft':
      return { before: null, after: `DRAFT page "${input.title}" (/${input.slug}/)\n\n${input.content}`, target: `new draft /${input.slug}/`, needsSnippet: false, page: null }
  }
}

interface Intent {
  site_id: number; task_id: number | null; kind: string; target: string; wp_id: number | null
  before: Record<string, unknown> | null; after: Record<string, unknown>; resource_key: string; input_key: string
}

async function requireHuman(q: Queryable, actor: string) {
  if ((await requireRunnableActor(q, actor)).kind !== 'human') throw new OpsError('Only a person may apply or undo WordPress changes.', 403)
}

async function recordIntent(db: Db, actor: string, c: Intent): Promise<ChangeRow> {
  return db.tx(async (q) => {
    await requireHuman(q, actor)
    // Serialize journal reservations, not network calls. The committed reservation
    // survives a process crash and blocks a second write with an unknown outcome.
    await q.query('select id from lp.seo_sites where id = $1 for update', [c.site_id])
    if (c.kind === 'create_draft') {
      const previous = await q.query<ChangeRow>("select * from lp.seo_changes where site_id = $1 and input_key = $2 and status = 'applied' order by id desc limit 1", [c.site_id, c.input_key])
      if (previous.rows[0]) return previous.rows[0]
    }
    const pending = await q.query<{ id: number }>("select id from lp.seo_changes where site_id = $1 and resource_key = $2 and status in ('applying', 'unknown', 'undoing', 'undo_unknown')", [c.site_id, c.resource_key])
    if (pending.rows[0]) throw new OpsError(`Change #${pending.rows[0].id} needs verification on WordPress before another write to this page. Do not retry it blindly.`, 409)
    const { rows } = await q.query<ChangeRow>(
      `insert into lp.seo_changes (site_id, task_id, kind, target, wp_id, before, after, applied_by, status, resource_key, input_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'applying',$9,$10) returning *`,
      [c.site_id, c.task_id, c.kind, c.target, c.wp_id, JSON.stringify(c.before), JSON.stringify(c.after), actor, c.resource_key, c.input_key],
    )
    await logEvent(q, { actor, kind: 'seo.change_prepared', summary: `Prepared WordPress change #${rows[0].id}: ${c.target}`, entity_type: 'seo_change', entity_id: rows[0].id })
    return rows[0]
  }, actor)
}

function matches(p: WpPage, fields: { status?: string; meta?: Record<string, string> }): boolean {
  return (!fields.status || p.status === fields.status) && Object.entries(fields.meta ?? {}).every(([k, v]) => (metaStr(p, k) ?? '') === v)
}

export async function applyChange(db: Db, actor: string, siteId: number, taskId: number | null, input: ApplyInput, env: ApplyEnv = {}): Promise<ChangeRow> {
  const site = await getSite(db, siteId)
  if (!site) throw new OpsError(`site ${siteId} not found`, 404)
  if (taskId) {
    const t = await getFixTask(db, taskId)
    if (!t) throw new OpsError(`fix ${taskId} not found`, 404)
  }
  await requireHuman(db, actor)
  const wp = client(env, site.base_url)
  const inputKey = createHash('sha256').update(JSON.stringify({ actor, siteId, taskId, input })).digest('hex')
  let plan: Intent
  let draft: { title: string; slug: string; content: string } | null = null
  switch (input.kind) {
    case 'set_meta':
    case 'add_schema': {
      const p = await pageAt(wp, input.path)
      if (!snippetInstalled(p)) throw new OpsError('WordPress doesn\'t expose these fields yet. Install the one-time snippet shown on this page first.', 412)
      const key = input.kind === 'set_meta' ? YOAST_META[input.field] : JSONLD_META
      const value = input.kind === 'add_schema' ? validateJsonLd(input.value) : input.value.trim()
      if (!value) throw new OpsError('The new value is empty.')
      const before = metaStr(p, key)
      if ((before ?? null) !== (input.expect_before ?? null)) throw new OpsError('The value on WordPress changed since your preview. Preview again before applying.', 409)
      plan = {
        site_id: siteId,
        task_id: taskId,
        kind: input.kind,
        target: `page ${p.id} ${input.path}`,
        wp_id: p.id,
        before: { type: p.type, meta: { [key]: before ?? '' } },
        after: { type: p.type, meta: { [key]: value } },
        resource_key: `${p.type}:${p.id}`, input_key: inputKey,
      }
      break
    }
    case 'hide_page': {
      const p = await pageAt(wp, input.path)
      if (input.mode === 'draft') {
        plan = {
          site_id: siteId, task_id: taskId, kind: 'unpublish_page', target: `page ${p.id} ${input.path}`, wp_id: p.id,
          before: { type: p.type, status: p.status }, after: { type: p.type, status: 'draft' },
          resource_key: `${p.type}:${p.id}`, input_key: inputKey,
        }
      } else {
        if (!snippetInstalled(p)) throw new OpsError('WordPress doesn\'t expose Yoast\'s noindex field yet. Install the one-time snippet, or use "Move to draft".', 412)
        const before = metaStr(p, YOAST_META.noindex)
        plan = {
          site_id: siteId, task_id: taskId, kind: 'set_meta', target: `page ${p.id} ${input.path}`, wp_id: p.id,
          before: { type: p.type, meta: { [YOAST_META.noindex]: before ?? '' } }, after: { type: p.type, meta: { [YOAST_META.noindex]: '1' } },
          resource_key: `${p.type}:${p.id}`, input_key: inputKey,
        }
      }
      break
    }
    case 'create_draft': {
      const title = input.title.trim()
      if (!title) throw new OpsError('The draft needs a title.')
      const slug = input.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
      if (!slug) throw new OpsError('The draft needs a nonempty slug.')
      draft = { title, slug, content: input.content }
      plan = {
        site_id: siteId, task_id: taskId, kind: 'create_draft', target: `new draft /${slug}/`, wp_id: null,
        before: null, after: { ...draft, type: 'page', status: 'draft' },
        resource_key: `draft:${slug}`, input_key: inputKey,
      }
      break
    }
  }
  const intent = await recordIntent(db, actor, plan)
  if (intent.status === 'applied') return intent // a successful draft request replay
  let mutationStarted = false
  let row: ChangeRow
  try {
    const type = plan.before?.type === 'post' ? 'post' : 'page'
    if (!draft) {
      const current = await wp.getPage(plan.wp_id!, type)
      if (!matches(current, plan.before ?? {})) throw new OpsError('WordPress changed before the write. Preview again.', 409)
    } else if (await wp.hasSlug(draft.slug)) {
      throw new OpsError('A WordPress page already uses this slug. Choose another slug or inspect that page first.', 409)
    }
    mutationStarted = true
    const p = draft ? await wp.createDraft(draft) : await wp.update(plan.wp_id!, type, plan.after)
    if (!p.id || (draft ? p.status !== 'draft' : !matches(p, plan.after))) throw new Error('WordPress did not confirm the requested fields.')
    // Verify the API read-back before reporting success (not a rendered-page check).
    const verified = await wp.getPage(p.id, p.type)
    if (!matches(verified, plan.after)) throw new Error('WordPress read-back did not match the requested fields.')
    row = await db.tx(async (q) => {
      const saved = await q.query<ChangeRow>("update lp.seo_changes set status = 'applied', wp_id = $2, resource_key = $3, applied_at = now(), error = null where id = $1 and status = 'applying' returning *", [intent.id, p.id, `${p.type}:${p.id}`])
      if (!saved.rows[0]) throw new Error('WordPress change reservation was lost.')
      await logEvent(q, { actor, kind: 'seo.change', summary: `Applied WordPress change #${intent.id} on ${site.name}: ${plan.target}`, entity_type: 'seo_change', entity_id: intent.id, task_id: taskId ?? undefined })
      if (taskId) await addComment(q, actor, { task_id: taskId, body: `Applied WordPress change #${intent.id}; undo available on the SEO fix page.`, kind: 'report' })
      return saved.rows[0]
    }, actor)
  } catch (e) {
    await db.query("update lp.seo_changes set status = $2, error = $3 where id = $1 and status = 'applying'", [intent.id, mutationStarted ? 'unknown' : 'failed', mutationStarted ? 'Outcome unknown. Inspect WordPress and this stored intent before retrying.' : 'No write sent. Preview again before applying.']).catch(() => undefined)
    if (mutationStarted) throw new OpsError(`Change #${intent.id} has an unknown outcome. Its before/after record is saved; inspect WordPress before retrying.`, 409)
    throw e
  }
  if (taskId) {
    const t = await getFixTask(db, taskId)
    if (t && ['queued', 'blocked'].includes(t.status) && !t.claimed_by && input.kind !== 'hide_page') await updateTask(db, actor, taskId, { status: 'done' })
  }
  return row
}

export async function getChange(q: Queryable, id: number): Promise<ChangeRow | null> {
  return (await q.query<ChangeRow>('select * from lp.seo_changes where id = $1', [id])).rows[0] ?? null
}
export async function listChanges(q: Queryable, opts: { taskId?: number | null; siteId?: number | null; limit?: number } = {}): Promise<ChangeRow[]> {
  return (
    await q.query<ChangeRow>(
      `select * from lp.seo_changes where ($1::bigint is null or task_id = $1) and ($2::bigint is null or site_id = $2) order by id desc limit $3`,
      [opts.taskId ?? null, opts.siteId ?? null, opts.limit ?? 50],
    )
  ).rows
}

/** Write back the stored "before". Refuses if WordPress no longer shows our "after" (someone edited it since). */
export async function undoChange(db: Db, actor: string, changeId: number, env: ApplyEnv = {}): Promise<ChangeRow> {
  const c = await getChange(db, changeId)
  if (!c) throw new OpsError(`change ${changeId} not found`, 404)
  if (c.status !== 'applied') throw new OpsError(`change #${changeId} is ${c.status}`, 409)
  const site = await getSite(db, c.site_id)
  if (!site) throw new OpsError('site not found', 404)
  await requireHuman(db, actor)
  const wp = client(env, site.base_url)
  const before = (c.before ?? {}) as { type?: 'page' | 'post'; status?: string; meta?: Record<string, string> }
  const after = (c.after ?? {}) as { type?: 'page' | 'post'; status?: string; meta?: Record<string, string> }
  const type = before.type ?? after.type ?? 'page'
  const resource = c.resource_key ?? `${type}:${c.wp_id}`
  await db.tx(async (q) => {
    await q.query('select id from lp.seo_sites where id = $1 for update', [c.site_id])
    const pending = await q.query("select id from lp.seo_changes where site_id = $1 and resource_key = $2 and status in ('applying','unknown','undoing','undo_unknown')", [c.site_id, resource])
    if (pending.rows.length) throw new OpsError('This page has an unfinished change; verify it before undoing.', 409)
    const reserved = await q.query("update lp.seo_changes set status = 'undoing', resource_key = $2 where id = $1 and status = 'applied' returning id", [changeId, resource])
    if (!reserved.rows.length) throw new OpsError('This change is already being undone or is no longer applied.', 409)
  }, actor)
  let mutationStarted = false
  try {
    if (c.kind === 'create_draft') {
      if (!c.wp_id) throw new OpsError('no WordPress id on this change', 409)
      const p = await wp.getPage(c.wp_id, 'page')
      if (p.status !== 'draft') throw new OpsError('That page is no longer a draft (someone published it), so it was left alone.', 409)
      mutationStarted = true
      await wp.trashDraft(c.wp_id)
      if ((await wp.getPage(c.wp_id, 'page')).status !== 'trash') throw new Error('WordPress did not confirm the draft was trashed.')
    } else if (c.kind === 'unpublish_page') {
      const p = await wp.getPage(c.wp_id!, type)
      if (p.status !== 'draft') throw new OpsError(`The page is ${p.status} now, not draft; left alone.`, 409)
      mutationStarted = true
      await wp.update(c.wp_id!, type, { status: before.status ?? 'publish' })
    } else {
      const p = await wp.getPage(c.wp_id!, type)
      for (const [k, v] of Object.entries(after.meta ?? {})) {
        if ((typeof p.meta?.[k] === 'string' ? p.meta?.[k] : '') !== v) throw new OpsError('The field was edited on WordPress after this change, so undo was not applied.', 409)
      }
      mutationStarted = true
      await wp.update(c.wp_id!, type, { meta: before.meta ?? {} })
    }
    if (c.kind !== 'create_draft' && !matches(await wp.getPage(c.wp_id!, type), before)) throw new Error('WordPress undo read-back did not match.')
    return await db.tx(async (q) => {
      const { rows } = await q.query<ChangeRow>(`update lp.seo_changes set status = 'undone', undone_by = $2, undone_at = now(), error = null where id = $1 and status = 'undoing' returning *`, [changeId, actor])
      if (!rows[0]) throw new Error('Undo reservation was lost.')
      await logEvent(q, { actor, kind: 'seo.change_undone', summary: `Undid change #${changeId} on ${site.name} (${c.target})`, entity_type: 'seo_change', entity_id: changeId, task_id: c.task_id ?? undefined })
      if (c.task_id) {
        await q.query(`update lp.tasks set status = 'queued', finished_at = null where id = $1 and status = 'done'`, [c.task_id])
        await addComment(q, actor, { task_id: c.task_id, body: `Undid change #${changeId}; the fix is open again.`, kind: 'comment' })
      }
      return rows[0]
    }, actor)
  } catch (e) {
    await db.query("update lp.seo_changes set status = $2, error = $3 where id = $1 and status = 'undoing'", [changeId, mutationStarted ? 'undo_unknown' : 'applied', mutationStarted ? 'Undo outcome unknown. Inspect WordPress before any further writes.' : null]).catch(() => undefined)
    if (mutationStarted) throw new OpsError(`Undo of change #${changeId} has an unknown outcome. Inspect WordPress before retrying.`, 409)
    throw e
  }
}
