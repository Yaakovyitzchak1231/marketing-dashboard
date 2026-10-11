import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { runVisibility, runResults, getFixTask, getSite, syncFixes, type AuditRow, type VisRun } from '@/lib/seo/store'
import { createCitationTask, loadCitationReport, citationSummary } from '@/lib/seo/citations'
import { claimTask, createTask } from '@/lib/ops/core'

let db: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.close() })
async function sample(text = 'TapDash is an option.') {
  return runVisibility(db, 'owner', 'perplexity', { maxPrompts: 1, env: { PERPLEXITY_API_KEY: 'unit-test-placeholder' }, fetcher: async () => ({ status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text } }], citations: ['https://other.test/guide'], search_results: [{ url: 'https://tapdash.co/jewelers/' }] }) }) })
}

describe('persisted citation evidence and human review tasks', () => {
  it('stores separate sources, text mention, site snapshot and effective Perplexity search setting', async () => {
    const run = await sample()
    expect(run).toMatchObject({ measurement_version: 2, web_search: true })
    expect(run.site_snapshot!.find((s) => s.id === 1)?.base_url).toBe('https://tapdash.co')
    const [r] = await runResults(db, [run.id])
    expect(r).toMatchObject({ text_mentioned: true, citation_urls: ['https://other.test/guide'], retrieved_urls: ['https://tapdash.co/jewelers/'] })
    expect(citationSummary(run, [r], 1)).toMatchObject({ mentioned: 1, cited: 0, answered: 1 })
  })

  it('retains the full measured answer so a late mention can be reproduced from its row', async () => {
    const text = `${'Context. '.repeat(2500)}TapDash.`
    const run = await sample(text)
    const [r] = await runResults(db, [run.id])
    expect(r.answer).toBe(text)
    expect(r.text_mentioned).toBe(true)
    expect(citationSummary(run, [r], 1)?.mentioned).toBe(1)
  })

  it('queues an evidence-linked review, deduplicates repeated clicks and preserves claimed work', async () => {
    const run = await sample()
    const [r] = await runResults(db, [run.id])
    const input = { site_id: 1, result_id: r.id, mode: 'review' as const }
    const first = await createCitationTask(db, 'owner', input)
    expect(first.created).toBe(true)
    await claimTask(db, 'tab', { task_id: first.id })
    const newer = await sample('Another answer.')
    const [r2] = await runResults(db, [newer.id])
    const again = await createCitationTask(db, 'owner', { ...input, result_id: r2.id })
    expect(again).toEqual({ id: first.id, created: false })
    const task = (await getFixTask(db, first.id))!
    expect(task.claimed_by).toBe('tab')
    expect(task.payload.citation_evidence).toMatchObject({ result_id: r.id, run_id: run.id })
    expect(task.payload.fix.action.type).toBe('manual')
    expect(task.payload.fix.detail).toContain('not a confirmed site defect')
  })

  it('prepares a WordPress draft TASK only; creates no website changes', async () => {
    const run = await sample()
    const [r] = await runResults(db, [run.id])
    const queued = await createCitationTask(db, 'owner', { site_id: 1, result_id: r.id, mode: 'draft' })
    const task = (await getFixTask(db, queued.id))!
    expect(task.payload.fix.action).toMatchObject({ type: 'create_draft', content: expect.stringContaining('EDITORIAL DRAFT') })
    expect((await db.query('select id from lp.seo_changes where task_id = $1', [queued.id])).rows).toHaveLength(0)
    await expect(createCitationTask(db, 'owner', { site_id: 2, result_id: r.id, mode: 'draft' })).rejects.toThrow(/WordPress/)
  })

  it('refuses agents, unmeasured/legacy rows, paused sites and changed site attribution', async () => {
    const run = await sample()
    const [r] = await runResults(db, [run.id])
    const input = { site_id: 1, result_id: r.id, mode: 'review' as const }
    await expect(createCitationTask(db, 'tab', input)).rejects.toThrow(/Only a human/)
    await db.query('update lp.seo_visibility_results set citation_urls = null where id = $1', [r.id])
    await expect(createCitationTask(db, 'owner', input)).rejects.toThrow(/no usable/)
    await db.query("update lp.seo_visibility_results set citation_urls = '{}' where id = $1", [r.id])
    await db.query('update lp.seo_sites set active = false where id = 1')
    await expect(createCitationTask(db, 'owner', input)).rejects.toThrow(/active site/)
    await db.query("update lp.seo_sites set active = true, base_url = 'https://changed.test' where id = 1")
    await expect(createCitationTask(db, 'owner', input)).rejects.toThrow(/snapshot/)
    await db.query("update lp.seo_sites set base_url = 'https://tapdash.co' where id = 1")
    await db.query('update lp.seo_visibility_runs set measurement_version = null where id = $1', [run.id])
    await expect(createCitationTask(db, 'owner', input)).rejects.toThrow(/snapshot/)
  })

  it('loads a bounded site-specific history and finds matching configurations', async () => {
    const a = await sample()
    const b = await sample()
    const report = await loadCitationReport(db, 1, b.id)
    expect(report.selected?.id).toBe(b.id)
    expect(report.previous?.id).toBe(a.id)
    expect(report.runs.length).toBeLessThanOrEqual(40)
    await expect(loadCitationReport(db, 1, 999999)).rejects.toThrow(/Run not found/)
    // A changed question must not be passed off as a like-for-like comparison.
    await db.query('update lp.seo_visibility_runs set prompts = $2 where id = $1', [b.id, JSON.stringify([{ prompt_id: 1, prompt: 'Different question' }])])
    expect((await loadCitationReport(db, 1, b.id)).previous).toBeNull()
  })

  it('retires obsolete optional advice without marking it fixed or touching claimed work', async () => {
    const old = await createTask(db, 'owner', { kind: 'seo_fix', title: 'Old llms requirement', dedupe_key: 'seo:1:llms_txt:', payload: { site_id: 1 } })
    const claimed = await createTask(db, 'owner', { kind: 'seo_fix', title: 'Old guide suggestion', dedupe_key: 'seo:1:draft:guide', payload: { site_id: 1 } })
    await claimTask(db, 'tab', { task_id: claimed.id })
    const audit = (await db.query<AuditRow>("insert into lp.seo_audits (site_id,status,checks) values (1,'done',$1) returning *", [JSON.stringify([{ id: 'llms_txt', label: 'llms.txt', status: 'info', detail: 'Optional' }])])).rows[0]
    expect(await syncFixes(db, 'owner', (await getSite(db, 1))!, audit)).toEqual({ created: 0, closed: 0 })
    const statuses = (await db.query<{ id: number; status: string }>('select id,status from lp.tasks where id = any($1) order by id', [[old.id, claimed.id]])).rows
    expect(statuses).toEqual([{ id: old.id, status: 'cancelled' }, { id: claimed.id, status: 'claimed' }])
  })

  it('escapes a stored question in the editable WordPress draft outline', async () => {
    const run = await sample()
    const [r] = await runResults(db, [run.id])
    await db.query('update lp.seo_visibility_results set prompt = $2 where id = $1', [r.id, '<img src=x onerror=alert(1)>?'])
    const queued = await createCitationTask(db, 'owner', { site_id: 1, result_id: r.id, mode: 'draft' })
    const action = (await getFixTask(db, queued.id))!.payload.fix.action
    expect(action.type).toBe('create_draft')
    if (action.type === 'create_draft') {
      expect(action.content).not.toContain('<img')
      expect(action.content).toContain('&lt;img')
    }
  })

  it('historical source arrays stay unknown rather than being relabelled as citations', async () => {
    const run = (await db.query<VisRun>("insert into lp.seo_visibility_runs (provider,model,status) values ('gemini','old','done') returning *")).rows[0]
    await db.query("insert into lp.seo_visibility_results (run_id,prompt,answer,mentioned,cited_urls) values ($1,'Old question','Old answer',false,array['https://tapdash.co'])", [run.id])
    const [r] = await runResults(db, [run.id])
    expect(r.cited_urls).toEqual(['https://tapdash.co'])
    expect(r.citation_urls).toBeNull()
    expect(r.text_mentioned).toBeNull()
    expect(citationSummary(run, [r], 1)).toBeNull()
  })
})
