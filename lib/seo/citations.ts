import { createHash } from 'node:crypto'
import type { Db, Queryable } from '@/lib/db/types'
import { createTask, OpsError } from '@/lib/ops/core'
import { getSite, runResults, SEO_PROJECT, SEO_TASK_KIND, type SiteRow, type VisResult, type VisRun, type VisSiteSnapshot } from './store'
import type { Fix } from './fixes'
import { analyzeAnswer, safeSourceUrl } from './visibility'

/** Domain boundaries matter: tapdash.co.evil.test is never an owned citation. */
export function citesSite(url: string, baseUrl: string): boolean {
  if (!safeSourceUrl(url) || !safeSourceUrl(baseUrl)) return false
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  const own = new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, '')
  return host === own || host.endsWith(`.${own}`)
}

export function snapshotFor(run: VisRun, siteId: number): VisSiteSnapshot | null {
  return run.measurement_version === 2 ? run.site_snapshot?.find((s) => s.id === siteId) ?? null : null
}

export function citationObservation(result: VisResult, site: VisSiteSnapshot) {
  if (result.error !== null || !result.answer?.trim() || result.text_mentioned == null || result.citation_urls == null) return null
  return {
    mentioned: analyzeAnswer({ text: result.answer, citedUrls: [] }, site.brand_terms, []).mentioned,
    citations: [...new Set(result.citation_urls.filter((u) => safeSourceUrl(u) !== null))],
    owned: [...new Set(result.citation_urls.filter((u) => citesSite(u, site.base_url)))],
    retrieved: [...new Set((result.retrieved_urls ?? []).filter((u) => safeSourceUrl(u) !== null))],
  }
}

export function citationSummary(run: VisRun, results: VisResult[], siteId: number) {
  const site = snapshotFor(run, siteId)
  const rows = results.filter((r) => r.run_id === run.id)
  if (!site || run.status === 'running' || !rows.length) return null
  let answered = 0, mentioned = 0, cited = 0, failed = 0, unknown = 0
  const urls = new Map<string, number>()
  for (const r of rows) {
    if (r.error !== null) { failed++; continue }
    const obs = citationObservation(r, site)
    if (!obs) { unknown++; continue }
    answered++
    if (obs.mentioned) mentioned++
    if (obs.owned.length) cited++
    for (const url of obs.citations) urls.set(url, (urls.get(url) ?? 0) + 1)
  }
  return {
    answered, failed, unknown,
    mentioned: answered ? mentioned : null,
    cited: answered ? cited : null,
    sources: [...urls].map(([url, answers]) => ({ url, answers, owned: citesSite(url, site.base_url) })).sort((a, b) => b.answers - a.answers || a.url.localeCompare(b.url)),
  }
}

/** Compare the same questions, site/brand definition, model and requested search mode only. */
export function comparableRuns(a: VisRun, b: VisRun, siteId: number): boolean {
  const sa = snapshotFor(a, siteId), sb = snapshotFor(b, siteId)
  if (!sa || !sb || a.status !== 'done' || b.status !== 'done' || !a.prompts?.length || !b.prompts?.length || a.web_search == null || b.web_search == null) return false
  const terms = (s: VisSiteSnapshot) => JSON.stringify([...s.brand_terms].sort())
  const prompts = (r: VisRun) => JSON.stringify(r.prompts!.map((p) => p.prompt).sort())
  return a.provider === b.provider && a.model === b.model && a.web_search === b.web_search && sa.base_url === sb.base_url && terms(sa) === terms(sb) && prompts(a) === prompts(b)
}

export async function loadCitationReport(q: Queryable, siteId: number, runId?: number) {
  const site = await getSite(q, siteId)
  if (!site) throw new OpsError('Site not found', 404)
  // Bounded history; no external requests on page load. Null snapshots are legacy,
  // so they are deliberately not assigned to a site using today's configuration.
  const runs = (await q.query<VisRun>(
    `select * from lp.seo_visibility_runs where site_snapshot @> $1::jsonb order by id desc limit 40`,
    [JSON.stringify([{ id: siteId }])],
  )).rows
  let selected = runId ? runs.find((r) => r.id === runId) ?? null : runs[0] ?? null
  if (runId && !selected) {
    // Evidence links in tasks remain usable beyond the recent-history window.
    selected = (await q.query<VisRun>('select * from lp.seo_visibility_runs where id = $1 and site_snapshot @> $2::jsonb', [runId, JSON.stringify([{ id: siteId }])])).rows[0] ?? null
    if (!selected) throw new OpsError('Run not found for this site', 404)
    runs.push(selected)
  }
  const previous = selected ? runs.find((r) => r.id < selected.id && comparableRuns(selected, r, siteId)) ?? null : null
  // The history picker needs run metadata only. Load answer bodies for at most
  // the selected run and its comparison, not forty runs of long model output.
  const results = await runResults(q, [selected, previous].filter((r): r is VisRun => r !== null).map((r) => r.id))
  return { site, runs, selected, previous, results }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Queue reviewable work from stored evidence. No publishing, provider calls or outreach. */
export async function createCitationTask(db: Db, actor: string, input: { site_id: number; result_id: number; mode: 'review' | 'draft' }): Promise<{ id: number; created: boolean }> {
  const who = (await db.query<{ kind: string }>('select kind from lp.actors where id = $1 and active', [actor])).rows[0]
  if (who?.kind !== 'human') throw new OpsError('Only a human can queue a citation improvement from here', 403)
  if (!['review', 'draft'].includes(input.mode)) throw new OpsError('Choose review or draft')
  const result = (await db.query<VisResult>('select * from lp.seo_visibility_results where id = $1', [input.result_id])).rows[0]
  if (!result) throw new OpsError('Answer evidence not found', 404)
  const run = (await db.query<VisRun>('select * from lp.seo_visibility_runs where id = $1', [result.run_id])).rows[0]
  const site: SiteRow | null = await getSite(db, input.site_id)
  const snapshot = run ? snapshotFor(run, input.site_id) : null
  if (!site?.active || !snapshot || snapshot.base_url !== site.base_url) throw new OpsError('This answer has no matching active site snapshot; run a new check first', 409)
  const obs = citationObservation(result, snapshot)
  if (run.status !== 'done' || !obs) throw new OpsError('This answer has no usable citation evidence', 409)
  if (input.mode === 'draft' && site.platform?.toLowerCase() !== 'wordpress') throw new OpsError('Draft creation is available for WordPress sites only', 409)
  const evidenceUrl = `/seo/citations?site=${site.id}&run=${run.id}#answer-${result.id}`
  const steps = [
    `Review stored answer #${result.id} from ${run.provider} (${run.model}) and its source links: ${evidenceUrl}`,
    'Check existing pages first. A single sampled answer does not prove a missing page, a ranking problem or why another source was selected.',
    'Prepare a direct, useful answer to the buyer question. Verify pricing, eligibility, comparisons and case-study claims against first-party evidence; do not copy a competitor or treat model output as fact.',
    'Propose relevant internal links and structured data only where it matches visible content. Obtain human approval before changing a live page or contacting anyone.',
    'After an approved change, repeat the same questions/model/search mode. Record mentions and citations separately; do not promise an increase or infer causation.',
  ]
  const fingerprint = createHash('sha256').update(result.prompt).digest('hex').slice(0, 24)
  const key = `citation:${fingerprint}:${input.mode}`
  const fix: Fix = {
    key, check_id: 'citation_review', page: null, severity: 'warn', priority: 30,
    title: `${input.mode === 'draft' ? 'Prepare an answer draft' : 'Review answer visibility'}: ${result.prompt}`.slice(0, 220),
    detail: `Stored answer #${result.id}, run #${run.id} (${run.provider}, ${run.model}): ${obs.mentioned ? 'brand named in text' : 'brand not named in text'}; ${obs.owned.length} site URLs among ${obs.citations.length} returned citation URLs. This is a review opportunity, not a confirmed site defect.`,
    fix: 'Use the linked evidence to review or improve an existing page first. New content and live changes need human review.',
    action: input.mode === 'review' ? { type: 'manual', steps } : {
      type: 'create_draft', title: result.prompt.slice(0, 180), slug: `buyer-answer-${fingerprint}`,
      content: `<p>EDITORIAL DRAFT — evidence review required; do not publish as-is.</p><h2>${escapeHtml(result.prompt)}</h2><p>EDIT: Write a concise answer supported by verified business facts.</p><h2>Evidence and practical examples</h2><p>EDIT: Add sourced facts, applicable limitations and genuine examples. Model answers are not factual sources.</p><h2>Next steps</h2><p>EDIT: Link to relevant existing pages and a useful next action for the reader.</p>`,
    },
  }
  const dedupe = `seo:${site.id}:${key}`
  const project = (await db.query<{ id: number }>('select id from lp.projects where name = $1', [SEO_PROJECT])).rows[0]
  try {
    const task = await createTask(db, actor, {
      kind: SEO_TASK_KIND, title: `${site.name}: ${fix.title}`.slice(0, 300), project_id: project?.id ?? null,
      priority: fix.priority, dedupe_key: dedupe,
      payload: { site_id: site.id, fix, citation_evidence: { run_id: run.id, result_id: result.id, provider: run.provider, model: run.model, web_search: run.web_search, captured_at: run.finished_at, site: snapshot } },
      body: `Evidence: ${evidenceUrl}\n\n${steps.join('\n')}`,
    })
    return { id: task.id, created: true }
  } catch (e) {
    if (!(e instanceof OpsError && e.status === 409)) throw e
    const existing = (await db.query<{ id: number }>("select id from lp.tasks where dedupe_key = $1 and status in ('queued','claimed','running','blocked','needs_approval')", [dedupe])).rows[0]
    if (!existing) throw e
    return { id: existing.id, created: false }
  }
}
