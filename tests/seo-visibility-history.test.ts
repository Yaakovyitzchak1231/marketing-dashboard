import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestDb } from './helpers/pglite-db'
import { runVisibility, runResults, type VisRun } from '@/lib/seo/store'
import { ask, visibilitySummary } from '@/lib/seo/visibility'
import type { Db } from '@/lib/db/types'
let db: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.close() })
const migration = readFileSync(join(__dirname, '../db/migrations/0017_visibility_accounting.sql'), 'utf8')

describe('visibility evidence and historical migration', () => {
  it('reclassifies stored empty negatives without inventing historical configuration', async () => {
    const r = await db.query<{ id: number }>("insert into lp.seo_visibility_runs (provider,model,status,prompt_count,mentioned) values ('gemini','historical','done',4,1) returning id")
    const id = r.rows[0].id
    await db.query("insert into lp.seo_visibility_results (run_id,prompt,answer,mentioned,error) values ($1,'empty','',false,null),($1,'whitespace',E'  \\n\\t',false,null),($1,'answered','TapDash',true,null),($1,'failed',null,null,'HTTP 500')", [id])
    for (let i = 0; i < 2; i++) for (const sql of migration.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await db.query(sql)
    const row = (await db.query<VisRun>('select * from lp.seo_visibility_runs where id = $1', [id])).rows[0]
    expect(row).toMatchObject({ attempted: 4, answered: 1, unknown: 2, failed: 1, mentioned: 1, web_search: null, brand_terms: null, prompts: null })
    const results = await runResults(db, [id])
    expect(results.map((r) => r.mentioned)).toEqual([null, null, true, null])
    expect(visibilitySummary(row)).toBe('matched in 1 of 1 answers (legacy text/source signal) · 2 unanswered · 1 error')
  })
  it('a result INSERT failure is not mislabeled as a provider error or a measured answer', async () => {
    const failing: Db = { tx: db.tx, query: (text, params) => {
      if (text.includes('insert into lp.seo_visibility_results')) throw new Error('result storage failed')
      return db.query(text, params)
    } }
    const fetcher = async () => ({ status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'TapDash' }] } }] }) })
    await expect(runVisibility(failing, 'owner', 'gemini', { env: { GEMINI_API_KEY: 'unit-test-placeholder' }, fetcher, maxPrompts: 1 })).rejects.toThrow(/result storage failed/)
    const row = (await db.query<VisRun>('select * from lp.seo_visibility_runs order by id desc limit 1')).rows[0]
    expect(row.status).toBe('running')
    expect(row.answered).toBeNull()
    expect(await runResults(db, [row.id])).toHaveLength(0)
  })
  it('explicit safety refusals stay unknown even when text mentions the brand', async () => {
    const fetcher = async () => ({ status: 200, text: async () => JSON.stringify({ candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'TapDash request blocked.' }] } }] }) })
    const row = await runVisibility(db, 'owner', 'gemini', { env: { GEMINI_API_KEY: 'unit-test-placeholder' }, fetcher, maxPrompts: 1 })
    expect(row).toMatchObject({ answered: 0, unknown: 1, failed: 0, mentioned: null })
    expect((await runResults(db, [row.id]))[0]).toMatchObject({ answer: 'TapDash request blocked.', mentioned: null })
  })
  it('recognizes OpenAI and Anthropic refusal metadata without guessing from prose', async () => {
    const response = (j: unknown) => async () => ({ status: 200, text: async () => JSON.stringify(j) })
    expect(await ask('openai', 'fixture', 'model', 'q', { fetcher: response({ output: [{ type: 'message', content: [{ type: 'refusal' }, { type: 'output_text', text: 'Refused' }] }] }) })).toMatchObject({ unanswered: true })
    expect(await ask('anthropic', 'fixture', 'model', 'q', { fetcher: response({ stop_reason: 'refusal', content: [{ type: 'text', text: 'Refused' }] }) })).toMatchObject({ unanswered: true })
  })
})
