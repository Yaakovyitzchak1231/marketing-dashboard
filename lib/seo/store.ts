import type { Db, Queryable } from '@/lib/db/types'
import { logEvent } from '@/lib/ops/events'
import { addComment, createTask, OpsError } from '@/lib/ops/core'
import { runAudit, summarize, type AuditOptions, type AuditPage, type Check } from './audit'
import { buildFixes, type Fix, type FixSite } from './fixes'
import { analyzeAnswer, ask, PROVIDERS, providerKey, providerModel, webSearchOn, type Answer, type HttpFetch, type ProviderId } from './visibility'

export const SEO_PROJECT = 'SEO / AI visibility'
export const SEO_TASK_KIND = 'seo_fix'

export interface SiteRow {
  id: number
  name: string
  base_url: string
  platform: string | null
  host: string | null
  campaign: string | null
  pages: string[]
  brand_terms: string[]
  active: boolean
  notes: string | null
  created_at: string
}

export interface AuditRow {
  id: number
  site_id: number
  status: 'running' | 'done' | 'failed'
  checks: Check[]
  pages: Record<string, AuditPage>
  sitemap_urls: string[] | null
  passed: number | null
  failed: number | null
  warned: number | null
  unknown: number | null
  fetched_from: string | null
  error: string | null
  created_by: string | null
  started_at: string
  finished_at: string | null
}

// ---------------------------------------------------------------- sites

export async function listSites(q: Queryable, opts: { activeOnly?: boolean } = {}): Promise<SiteRow[]> {
  const { rows } = await q.query<SiteRow>(`select * from lp.seo_sites ${opts.activeOnly ? 'where active' : ''} order by id`)
  return rows
}

export async function getSite(q: Queryable, id: number): Promise<SiteRow | null> {
  const { rows } = await q.query<SiteRow>('select * from lp.seo_sites where id = $1', [id])
  return rows[0] ?? null
}

export function normalizeBaseUrl(input: string): string {
  const raw = input.trim()
  if (!raw) throw new OpsError('site URL is required')
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new OpsError(`"${raw}" is not a URL`)
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw new OpsError(`"${raw}" is not a website address`)
  return `${u.protocol}//${u.host.toLowerCase()}`
}

export function parsePaths(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[\s,]+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          try {
            if (/^https?:\/\//i.test(p)) p = new URL(p).pathname
          } catch {
            /* keep as typed */
          }
          p = p.startsWith('/') ? p : `/${p}`
          return p.endsWith('/') || /\.[a-z0-9]+$/i.test(p) ? p : `${p}/`
        })
        .filter((p) => p !== '/'),
    ),
  ].slice(0, 20)
}

export async function addSite(
  db: Db,
  actor: string,
  input: { name?: string; base_url: string; platform?: string | null; host?: string | null; campaign?: string | null; pages?: string[]; brand_terms?: string[] },
): Promise<SiteRow> {
  const base = normalizeBaseUrl(input.base_url)
  const host = new URL(base).host.replace(/^www\./, '')
  return db.tx(async (q) => {
    const { rows } = await q.query<SiteRow>(
      `insert into lp.seo_sites (name, base_url, platform, host, campaign, pages, brand_terms, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (base_url) do update set active = true, name = excluded.name, platform = coalesce(excluded.platform, lp.seo_sites.platform),
         host = coalesce(excluded.host, lp.seo_sites.host), campaign = coalesce(excluded.campaign, lp.seo_sites.campaign),
         pages = case when cardinality(excluded.pages) > 0 then excluded.pages else lp.seo_sites.pages end
       returning *`,
      [
        (input.name || host).trim().slice(0, 120),
        base,
        input.platform?.trim() || null,
        input.host?.trim() || null,
        input.campaign?.trim() || null,
        input.pages ?? [],
        input.brand_terms?.length ? input.brand_terms : ['TapDash', host],
        actor,
      ],
    )
    await logEvent(q, { actor, kind: 'seo.site_added', summary: `Tracking ${rows[0].name} (${base}) for SEO and AI visibility`, entity_type: 'seo_site', entity_id: rows[0].id })
    return rows[0]
  }, actor)
}

export async function setSiteActive(db: Db, actor: string, id: number, active: boolean): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query<SiteRow>('update lp.seo_sites set active = $2 where id = $1 returning *', [id, active])
    if (!rows[0]) throw new OpsError(`site ${id} not found`, 404)
    await logEvent(q, { actor, kind: 'seo.site_updated', summary: `${active ? 'Resumed' : 'Paused'} tracking ${rows[0].name}`, entity_type: 'seo_site', entity_id: id })
  }, actor)
}

// ---------------------------------------------------------------- audits

export async function latestAudits(q: Queryable): Promise<Map<number, AuditRow>> {
  const { rows } = await q.query<AuditRow>(
    `select distinct on (site_id) * from lp.seo_audits where status = 'done' order by site_id, id desc`,
  )
  return new Map(rows.map((r) => [r.site_id, r]))
}

export async function auditHistory(q: Queryable, siteId: number | null, limit = 20): Promise<AuditRow[]> {
  const { rows } = await q.query<AuditRow>(
    `select * from lp.seo_audits where ($1::bigint is null or site_id = $1) order by id desc limit $2`,
    [siteId, limit],
  )
  return rows
}

export async function getAudit(q: Queryable, id: number): Promise<AuditRow | null> {
  const { rows } = await q.query<AuditRow>('select * from lp.seo_audits where id = $1', [id])
  return rows[0] ?? null
}

/** Run the audit for one site, store it, and refresh that site's fix list. */
export async function runSiteAudit(
  db: Db,
  actor: string,
  siteId: number,
  opts: AuditOptions & { fetchedFrom?: string } = {},
): Promise<{ audit: AuditRow; fixes: { created: number; closed: number } }> {
  const site = await getSite(db, siteId)
  if (!site) throw new OpsError(`site ${siteId} not found`, 404)
  const { rows: started } = await db.query<{ id: number }>(
    `insert into lp.seo_audits (site_id, status, fetched_from, created_by) values ($1, 'running', $2, $3) returning id`,
    [siteId, opts.fetchedFrom ?? 'dashboard server', actor],
  )
  const id = started[0].id
  try {
    const res = await runAudit(site, opts)
    const s = summarize(res.checks)
    const audit = await db.tx(async (q) => {
      const { rows } = await q.query<AuditRow>(
        `update lp.seo_audits set status = 'done', checks = $2, pages = $3, sitemap_urls = $4, passed = $5, failed = $6, warned = $7, unknown = $8, finished_at = now()
          where id = $1 returning *`,
        [id, JSON.stringify(res.checks), JSON.stringify(res.pages), res.sitemapUrls ? JSON.stringify(res.sitemapUrls) : null, s.passed, s.failed, s.warned, s.unknown + s.blocked],
      )
      await logEvent(q, {
        actor,
        kind: 'seo.audit',
        summary: `SEO audit of ${site.name}: ${s.passed} passed, ${s.failed} failed, ${s.warned} to improve, ${s.blocked ? `${s.blocked} blocked from our checker, ` : ''}${s.unknown} couldn't be checked`,
        entity_type: 'seo_audit',
        entity_id: id,
      })
      return rows[0]
    }, actor)
    const fixes = await syncFixes(db, actor, site, audit)
    return { audit, fixes }
  } catch (e) {
    await db.query(`update lp.seo_audits set status = 'failed', error = $2, finished_at = now() where id = $1`, [id, (e as Error).message.slice(0, 2000)])
    throw e
  }
}

// ---------------------------------------------------------------- fix list (lp.tasks kind seo_fix)

export interface FixTask {
  id: number
  title: string
  status: string
  priority: number
  assigned_to: string | null
  claimed_by: string | null
  created_at: string
  finished_at: string | null
  report: string | null
  payload: { site_id: number; fix: Fix; citation_evidence?: { run_id: number; result_id: number; provider: string; model: string; captured_at: string | null } }
  site_name: string | null
}

async function seoProjectId(q: Queryable): Promise<number | null> {
  const { rows } = await q.query<{ id: number }>('select id from lp.projects where name = $1', [SEO_PROJECT])
  return rows[0]?.id ?? null
}

const LIVE = ['queued', 'claimed', 'running', 'blocked', 'needs_approval']

export async function competitorCounts(q: Queryable): Promise<{ name: string; count: number }[]> {
  const { rows } = await q.query<{ name: string; count: number }>(
    `with latest as (select distinct on (provider) id from lp.seo_visibility_runs where status = 'done' order by provider, id desc)
     select c as name, count(*)::int as count
       from lp.seo_visibility_results r, unnest(r.competitors) c
      where r.run_id in (select id from latest)
      group by c order by count desc, c`,
  )
  return rows
}

/** Create a task per open fix (deduped while live); close live, unclaimed tasks whose check now passes. */
export async function syncFixes(db: Db, actor: string, site: SiteRow, audit: AuditRow): Promise<{ created: number; closed: number }> {
  const fs: FixSite = { id: site.id, name: site.name, base_url: site.base_url, platform: site.platform, host: site.host, campaign: site.campaign }
  // Content ideas are queued explicitly from citation evidence, not inferred
  // as missing pages from a partial or unavailable sitemap.
  const fixes = buildFixes(fs, audit.checks, audit.pages, audit.sitemap_urls)
  const projectId = await seoProjectId(db)
  let created = 0
  for (const f of fixes) {
    try {
      await createTask(db, actor, {
        kind: SEO_TASK_KIND,
        title: `${site.name}: ${f.title}`,
        project_id: projectId,
        payload: { site_id: site.id, audit_id: audit.id, fix: f },
        priority: f.priority,
        dedupe_key: `seo:${site.id}:${f.key}`,
      })
      created++
    } catch (e) {
      if (!(e instanceof OpsError && e.status === 409)) throw e
      // Already on the board: refresh its finding so the fix shows today's numbers.
      await db.query(
        `update lp.tasks set payload = $2 where dedupe_key = $1 and status = any($3) and claimed_by is null`,
        [`seo:${site.id}:${f.key}`, JSON.stringify({ site_id: site.id, audit_id: audit.id, fix: f }), LIVE],
      )
    }
  }
  // Close what the audit now shows as fixed (only checks this audit actually measured as pass).
  const passed = new Set(audit.checks.filter((c) => c.status === 'pass').map((c) => `seo:${site.id}:${c.id}:${c.page ?? ''}`))
  const informational = new Set(audit.checks.filter((c) => c.status === 'info').map((c) => `seo:${site.id}:${c.id}:${c.page ?? ''}`))
  // Checks our checker was blocked from reading: an open fix for one came from an earlier
  // read we can no longer confirm (often a blocked request misread as a failure).
  const blockedChecks = audit.checks.filter((c) => c.status === 'blocked')
  const blockedReason = (k: string): string | null => {
    const c = blockedChecks.find((x) => k === `seo:${site.id}:${x.id}:${x.page ?? ''}` || (x.id === 'sitemap' && k.startsWith(`seo:${site.id}:sitemap:`)))
    return c ? (c.reason ?? c.detail) : null
  }
  const open = new Set(fixes.map((f) => `seo:${site.id}:${f.key}`))
  const { rows: live } = await db.query<{ id: number; dedupe_key: string }>(
    `select id, dedupe_key from lp.tasks where kind = $1 and dedupe_key like $2 and status = any($3) and claimed_by is null`,
    [SEO_TASK_KIND, `seo:${site.id}:%`, LIVE],
  )
  let closed = 0
  for (const t of live) {
    if (open.has(t.dedupe_key)) continue
    const k = t.dedupe_key
    if (informational.has(k) || k.startsWith(`seo:${site.id}:draft:`)) {
      // Retire obsolete advice, not 'confirm' a visibility improvement. Claimed
      // tasks stay with their owner; the audit must not modify active work.
      await db.tx(async (q) => {
        const retired = await q.query("update lp.tasks set status = 'cancelled', finished_at = now() where id = $1 and claimed_by is null and status in ('queued','blocked') returning id", [t.id])
        if (!retired.rows.length) return
        await addComment(q, 'system', { task_id: t.id, body: `Audit #${audit.id}: this is optional guidance or an unverified content idea, not a required fix. Review new content opportunities from stored citation evidence.`, kind: 'report' })
        await logEvent(q, { actor: 'system', kind: 'task.cancelled', summary: `Retired unsupported SEO recommendation #${t.id}.`, task_id: t.id, entity_type: 'task', entity_id: t.id })
      })
      continue
    }
    const blockedNow = blockedReason(k)
    if (blockedNow) {
      await db.tx(async (q) => {
        const retired = await q.query("update lp.tasks set status = 'cancelled', finished_at = now() where id = $1 and claimed_by is null and status in ('queued','blocked') returning id", [t.id])
        if (!retired.rows.length) return
        await addComment(q, 'system', { task_id: t.id, body: `Audit #${audit.id} couldn't read this: ${blockedNow}. Not a confirmed site problem, so it's off the fix list; a readable audit re-adds it if it's real.`, kind: 'report' })
        await logEvent(q, { actor: 'system', kind: 'task.cancelled', summary: `Retired SEO fix #${t.id}: audit #${audit.id} was blocked from reading it.`, task_id: t.id, entity_type: 'task', entity_id: t.id })
      })
      continue
    }
    const nowPasses = passed.has(k) || (k.startsWith(`seo:${site.id}:sitemap:`) && audit.checks.some((c) => c.id === 'sitemap' && c.status === 'pass'))
    if (!nowPasses) continue
    const didClose = await db.tx(async (q) => {
      // Internal evidence-based reconciliation, not the public manual-edit API.
      // Never close work that was claimed after this audit began.
      const done = await q.query("update lp.tasks set status = 'done', finished_at = now() where id = $1 and claimed_by is null and status in ('queued','blocked') returning id", [t.id])
      if (!done.rows.length) return false
      await addComment(q, 'system', { task_id: t.id, body: `Re-audit #${audit.id} shows this fixed.`, kind: 'report' })
      await logEvent(q, { actor: 'system', kind: 'task.done', summary: `Re-audit #${audit.id} verified fix #${t.id}.`, task_id: t.id, entity_type: 'task', entity_id: t.id })
      return true
    }, 'system')
    if (didClose) closed++
  }
  return { created, closed }
}

export async function listFixTasks(q: Queryable, opts: { siteId?: number | null; open?: boolean } = {}): Promise<FixTask[]> {
  const { rows } = await q.query<FixTask>(
    `select t.id, t.title, t.status, t.priority, t.assigned_to, t.claimed_by, t.created_at, t.finished_at, t.report, t.payload, s.name as site_name
       from lp.tasks t left join lp.seo_sites s on s.id = (t.payload->>'site_id')::bigint
      where t.kind = $1
        and ($2::bigint is null or (t.payload->>'site_id')::bigint = $2)
        and ($3::boolean is null or ($3 and t.status = any($4)) or (not $3 and not (t.status = any($4))))
      order by (t.status = any($4)) desc, t.priority desc, t.id`,
    [SEO_TASK_KIND, opts.siteId ?? null, opts.open ?? null, LIVE],
  )
  return rows
}

export async function getFixTask(q: Queryable, id: number): Promise<FixTask | null> {
  const { rows } = await q.query<FixTask>(
    `select t.id, t.title, t.status, t.priority, t.assigned_to, t.claimed_by, t.created_at, t.finished_at, t.report, t.payload, s.name as site_name
       from lp.tasks t left join lp.seo_sites s on s.id = (t.payload->>'site_id')::bigint
      where t.id = $1 and t.kind = $2`,
    [id, SEO_TASK_KIND],
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------- prompts & competitors

export interface PromptRow {
  id: number
  prompt: string
  campaign: string | null
  active: boolean
}
export async function listPrompts(q: Queryable): Promise<PromptRow[]> {
  return (await q.query<PromptRow>('select id, prompt, campaign, active from lp.seo_prompts order by active desc, id')).rows
}
export async function addPrompt(db: Db, actor: string, prompt: string, campaign: string | null): Promise<PromptRow> {
  const p = prompt.trim().replace(/\s+/g, ' ')
  if (p.length < 8) throw new OpsError('write the question the way a buyer would ask it (at least a few words)')
  return db.tx(async (q) => {
    const { rows } = await q.query<PromptRow>(
      `insert into lp.seo_prompts (prompt, campaign, created_by) values ($1, $2, $3)
       on conflict ((lower(prompt))) do update set active = true returning id, prompt, campaign, active`,
      [p.slice(0, 500), campaign?.trim() || null, actor],
    )
    await logEvent(q, { actor, kind: 'seo.prompt_added', summary: `Added AI-visibility question: "${p.slice(0, 120)}"`, entity_type: 'seo_prompt', entity_id: rows[0].id })
    return rows[0]
  }, actor)
}
export async function setPromptActive(db: Db, actor: string, id: number, active: boolean): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query<PromptRow>('update lp.seo_prompts set active = $2 where id = $1 returning id, prompt, campaign, active', [id, active])
    if (!rows[0]) throw new OpsError(`question ${id} not found`, 404)
    await logEvent(q, { actor, kind: 'seo.prompt_updated', summary: `${active ? 'Turned on' : 'Turned off'} question: "${rows[0].prompt.slice(0, 120)}"`, entity_type: 'seo_prompt', entity_id: id })
  }, actor)
}

export async function listCompetitors(q: Queryable): Promise<{ id: number; name: string; domain: string | null }[]> {
  return (await q.query<{ id: number; name: string; domain: string | null }>('select id, name, domain from lp.seo_competitors order by name')).rows
}
export async function addCompetitor(db: Db, actor: string, name: string, domain: string | null): Promise<void> {
  const n = name.trim()
  if (!n) throw new OpsError('competitor name is required')
  const d = domain?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null
  await db.tx(async (q) => {
    await q.query(`insert into lp.seo_competitors (name, domain) values ($1, $2) on conflict ((lower(name))) do update set domain = coalesce(excluded.domain, lp.seo_competitors.domain)`, [n.slice(0, 80), d])
    await logEvent(q, { actor, kind: 'seo.competitor_added', summary: `Watching for ${n} in AI answers` })
  }, actor)
}
export async function removeCompetitor(db: Db, actor: string, id: number): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ name: string }>('delete from lp.seo_competitors where id = $1 returning name', [id])
    if (rows[0]) await logEvent(q, { actor, kind: 'seo.competitor_removed', summary: `Stopped watching for ${rows[0].name}` })
  }, actor)
}

// ---------------------------------------------------------------- AI visibility

export interface VisRunPrompt {
  prompt_id: number | null
  prompt: string
}

export interface VisSiteSnapshot {
  id: number
  name: string
  base_url: string
  brand_terms: string[]
}
export interface VisRun {
  measurement_version?: number | null
  site_snapshot?: VisSiteSnapshot[] | null
  id: number
  provider: string
  model: string
  status: 'running' | 'done' | 'failed'
  prompt_count: number | null
  mentioned: number | null
  /** How the run went: attempted = answered + failed + unknown. Null on rows written before 0017. */
  attempted: number | null
  answered: number | null
  failed: number | null
  unknown: number | null
  /** The configuration the run used, snapshotted so a later edit can't rewrite its meaning. */
  web_search: boolean | null
  brand_terms: string[] | null
  prompts: VisRunPrompt[] | null
  error: string | null
  started_at: string
  finished_at: string | null
}
export interface VisResult {
  id: number
  run_id: number
  prompt_id: number | null
  prompt: string
  answer: string | null
  error: string | null
  mentioned: boolean | null
  matched_terms: string[]
  competitors: string[]
  /** Historical mixed source list; do not interpret as verified citations. */
  cited_urls: string[]
  text_mentioned?: boolean | null
  citation_urls?: string[] | null
  retrieved_urls?: string[] | null
}

export async function brandTerms(q: Queryable): Promise<string[]> {
  const sites = await listSites(q, { activeOnly: true })
  const terms = new Set<string>()
  for (const s of sites) {
    for (const t of s.brand_terms) terms.add(t)
    terms.add(new URL(s.base_url).host.replace(/^www\./, ''))
  }
  return [...terms]
}

export async function runVisibility(
  db: Db,
  actor: string,
  provider: ProviderId,
  opts: { env?: Record<string, string | undefined>; fetcher?: HttpFetch; maxPrompts?: number } = {},
): Promise<VisRun> {
  const env = opts.env ?? process.env
  const info = PROVIDERS.find((p) => p.id === provider)
  if (!info) throw new OpsError(`unknown provider ${provider}`)
  const key = providerKey(info, env)
  if (!key) throw new OpsError(`${info.label} isn't set up: add ${info.env} to the environment first.`, 412)
  const model = providerModel(info, env)
  const webSearch = provider === 'perplexity' || webSearchOn(env)
  const prompts = (await listPrompts(db)).filter((p) => p.active).slice(0, opts.maxPrompts ?? 25)
  if (!prompts.length) throw new OpsError('no active questions to ask')
  const sites = await listSites(db, { activeOnly: true })
  const siteSnapshot: VisSiteSnapshot[] = sites.map((s) => ({ id: s.id, name: s.name, base_url: s.base_url, brand_terms: [...new Set([...s.brand_terms, new URL(s.base_url).hostname.replace(/^www\./, '')])] }))
  const terms = [...new Set(siteSnapshot.flatMap((s) => s.brand_terms))]
  const comps = await listCompetitors(db)
  const snapshot: VisRunPrompt[] = prompts.map((p) => ({ prompt_id: p.id, prompt: p.prompt }))
  const { rows: r0 } = await db.query<{ id: number }>(
    `insert into lp.seo_visibility_runs (provider, model, prompt_count, web_search, brand_terms, prompts, created_by, measurement_version, site_snapshot)
     values ($1, $2, $3, $4, $5, $6, $7, 2, $8) returning id`,
    [provider, model, prompts.length, webSearch, terms, JSON.stringify(snapshot), actor, JSON.stringify(siteSnapshot)],
  )
  const runId = r0[0].id
  for (const p of prompts) {
    let a: Answer
    try {
      a = await ask(provider, key, model, p.prompt, { fetcher: opts.fetcher, webSearch })
    } catch (e) {
      await db.query(`insert into lp.seo_visibility_results (run_id, prompt_id, prompt, error) values ($1, $2, $3, $4)`, [runId, p.id, p.prompt, (e as Error).message.slice(0, 1000)])
      continue
    }
    // An empty/blocked response is not a measured negative. Preserve any
    // explanatory text, but never interpret a provider refusal as an answer.
    if (a.unanswered || !a.text.trim()) {
      await db.query(
        `insert into lp.seo_visibility_results (run_id, prompt_id, prompt, answer, mentioned) values ($1, $2, $3, $4, null)`,
        [runId, p.id, p.prompt, a.text ? a.text.slice(0, 20000) : null],
      )
      continue
    }
    // Analyze exactly the text we retain, so displayed evidence can reproduce the verdict.
    const answer = a.text
    const an = analyzeAnswer({ ...a, text: answer }, terms, comps)
    await db.query(
      `insert into lp.seo_visibility_results (run_id, prompt_id, prompt, answer, mentioned, matched_terms, competitors, cited_urls, text_mentioned, citation_urls, retrieved_urls)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $5, $8, $9)`,
      [runId, p.id, p.prompt, answer, an.mentioned, an.matchedTerms, an.competitors, a.citedUrls, a.retrievedUrls ?? []],
    )
  }
  return db.tx(async (q) => {
    // The summary is derived from committed result rows, not optimistic counters
    // advanced before an INSERT which could fail.
    const counts = await q.query<{ attempted: number; answered: number; failed: number; unknown: number; mentioned: number }>(
      `select count(*)::int as attempted,
              count(*) filter (where error is null and mentioned is not null)::int as answered,
              count(*) filter (where error is not null)::int as failed,
              count(*) filter (where error is null and mentioned is null)::int as unknown,
              count(*) filter (where error is null and mentioned = true)::int as mentioned
         from lp.seo_visibility_results where run_id = $1`, [runId],
    )
    const { attempted, answered, failed, unknown, mentioned } = counts.rows[0]
    const status = answered === 0 ? 'failed' : 'done'
    const { rows } = await q.query<VisRun>(
      `update lp.seo_visibility_runs
          set status = $2, mentioned = $3, attempted = $4, answered = $5, failed = $6, unknown = $7, error = $8, finished_at = now()
        where id = $1 returning *`,
      [
        runId,
        status,
        answered ? mentioned : null,
        attempted,
        answered,
        failed,
        unknown,
        answered ? null : 'No readable answers were returned. See results for errors and unanswered questions.',
      ],
    )
    await logEvent(q, {
      actor,
      kind: 'seo.visibility',
      summary: answered
        ? `AI visibility check on ${info.label}: TapDash named in ${mentioned} of ${answered} answers${unknown ? ` (${unknown} couldn't be read)` : ''}`
        : `AI visibility check on ${info.label} failed: no answers came back`,
      entity_type: 'seo_visibility_run',
      entity_id: runId,
    })
    return rows[0]
  }, actor)
}

export async function latestRuns(q: Queryable): Promise<VisRun[]> {
  return (await q.query<VisRun>(`select distinct on (provider) * from lp.seo_visibility_runs order by provider, id desc`)).rows
}
export async function runResults(q: Queryable, runIds: number[]): Promise<VisResult[]> {
  if (!runIds.length) return []
  return (await q.query<VisResult>('select * from lp.seo_visibility_results where run_id = any($1) order by id', [runIds])).rows
}
export async function recentRuns(q: Queryable, limit = 20): Promise<VisRun[]> {
  return (await q.query<VisRun>('select * from lp.seo_visibility_runs order by id desc limit $1', [limit])).rows
}
