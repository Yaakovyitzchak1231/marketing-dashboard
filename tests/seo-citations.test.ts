import { describe, expect, it } from 'vitest'
import { ask, analyzeAnswer, safeSourceUrl } from '@/lib/seo/visibility'
import { citationObservation, citationSummary, citesSite, comparableRuns } from '@/lib/seo/citations'
import type { VisRun, VisResult } from '@/lib/seo/store'

const fetcher = (body: unknown) => async () => ({ status: 200, text: async () => JSON.stringify(body) })
const site = { id: 1, name: 'TapDash', base_url: 'https://tapdash.co', brand_terms: ['TapDash', 'tapdash.co'] }
const run: VisRun = { id: 1, provider: 'gemini', model: 'fixture', status: 'done', measurement_version: 2, site_snapshot: [site], prompt_count: 1, mentioned: 0, attempted: 1, answered: 1, failed: 0, unknown: 0, web_search: true, brand_terms: site.brand_terms, prompts: [{ prompt_id: 1, prompt: 'Buyer question' }], error: null, started_at: '2026-10-09T12:00:00Z', finished_at: '2026-10-09T12:01:00Z' }
const result: VisResult = { id: 1, run_id: 1, prompt_id: 1, prompt: 'Buyer question', answer: 'Consider your requirements.', mentioned: false, text_mentioned: false, citation_urls: ['https://tapdash.co/guide', 'https://other.test/guide'], retrieved_urls: ['https://not-cited.test/'], cited_urls: [], error: null, matched_terms: [], competitors: [] }

describe('provider citation provenance', () => {
  it('Gemini only counts chunks referenced by grounding supports as citations', async () => {
    const a = await ask('gemini', 'fixture', 'fixture', 'q', { fetcher: fetcher({ candidates: [{ content: { parts: [{ text: 'Answer' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://cited.test/a' } }, { web: { uri: 'https://retrieved.test/b' } }], groundingSupports: [{ groundingChunkIndices: [0, 0, 900, -1] }] } }] }) })
    expect(a.citedUrls).toEqual(['https://cited.test/a'])
    expect(a.retrievedUrls).toEqual(['https://cited.test/a', 'https://retrieved.test/b'])
  })
  it('Gemini chunks alone are retrieved sources, not evidence of a citation', async () => {
    const a = await ask('gemini', 'fixture', 'fixture', 'q', { fetcher: fetcher({ candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://tapdash.co' } }] } }] }) })
    expect(a.citedUrls).toEqual([])
    expect(a.retrievedUrls).toEqual(['https://tapdash.co/'])
  })
  it('Perplexity search_results do not inflate citations', async () => {
    const a = await ask('perplexity', 'fixture', 'fixture', 'q', { fetcher: fetcher({ choices: [{ message: { content: 'Answer' } }], citations: ['https://cited.test/a'], search_results: [{ url: 'https://retrieved.test/b' }] }) })
    expect(a.citedUrls).toEqual(['https://cited.test/a'])
    expect(a.retrievedUrls).toEqual(['https://retrieved.test/b'])
  })
  it('OpenAI annotations and search-call sources remain separate; unsafe URLs are rejected', async () => {
    const a = await ask('openai', 'fixture', 'fixture', 'q', { fetcher: fetcher({ output: [{ type: 'web_search_call', action: { sources: [{ url: 'https://retrieved.test' }] } }, { type: 'message', content: [{ type: 'output_text', text: 'Answer', annotations: [{ type: 'url_citation', url: 'https://cited.test' }, { type: 'url_citation', url: 'javascript:alert(1)' }, { type: 'file_citation', url: 'https://file.test' }] }] }] }) })
    expect(a.citedUrls).toEqual(['https://cited.test/'])
    expect(a.retrievedUrls).toEqual(['https://retrieved.test/'])
    expect(safeSourceUrl('https://user:pass@example.test')).toBeNull()
  })
  it('Anthropic citations are not the same as web-search-tool results', async () => {
    const a = await ask('anthropic', 'fixture', 'fixture', 'q', { fetcher: fetcher({ content: [{ type: 'text', text: 'Answer', citations: [{ url: 'https://cited.test' }] }, { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://retrieved.test' }] }] }) })
    expect(a.citedUrls).toEqual(['https://cited.test/'])
    expect(a.retrievedUrls).toEqual(['https://retrieved.test/'])
  })
  it('citing a brand site without naming it is not a text mention', () => {
    expect(analyzeAnswer({ text: 'Other options.', citedUrls: ['https://tapdash.co'] }, site.brand_terms, []).mentioned).toBe(false)
    expect(citationObservation(result, site)).toMatchObject({ mentioned: false, owned: ['https://tapdash.co/guide'] })
    expect(citationObservation({ ...result, answer: 'TapDash.', text_mentioned: true, citation_urls: [] }, site)).toMatchObject({ mentioned: true, owned: [] })
  })
})

describe('site attribution and comparable history', () => {
  it('rejects lookalike domains and unsafe schemes', () => {
    expect(citesSite('https://www.tapdash.co/page', site.base_url)).toBe(true)
    expect(citesSite('https://docs.tapdash.co/page', site.base_url)).toBe(true)
    expect(citesSite('https://tapdash.co.attacker.test/page', site.base_url)).toBe(false)
    expect(citesSite('https://nottapdash.co/page', site.base_url)).toBe(false)
    expect(citesSite('ftp://tapdash.co/file', site.base_url)).toBe(false)
  })
  it('counts citing answers, not duplicate links; errors and legacy unknowns stay separate', () => {
    const summary = citationSummary(run, [
      { ...result, citation_urls: [...result.citation_urls!, ...result.citation_urls!] },
      { ...result, id: 2, answer: null, mentioned: null, text_mentioned: null, citation_urls: null },
      { ...result, id: 3, error: 'unavailable' },
    ], 1)
    expect(summary).toMatchObject({ answered: 1, mentioned: 0, cited: 1, unknown: 1, failed: 1 })
    expect(summary!.sources).toHaveLength(2)
    expect(summary!.sources.every((s) => s.answers === 1)).toBe(true)
    expect(citationSummary({ ...run, measurement_version: null }, [result], 1)).toBeNull()
    expect(citationSummary(run, [], 1)).toBeNull()
    expect(citationSummary(run, [{ ...result, error: 'failed' }], 1)).toMatchObject({ cited: null, mentioned: null, answered: 0 })
  })
  it('only compares like-for-like completed samples', () => {
    expect(comparableRuns(run, { ...run, id: 2 }, 1)).toBe(true)
    for (const patch of [{ model: 'other' }, { provider: 'openai' }, { web_search: false }, { web_search: null }, { status: 'running' as const }, { prompts: [{ prompt_id: 1, prompt: 'changed' }] }, { site_snapshot: [{ ...site, brand_terms: ['Other'] }] }, { site_snapshot: [{ ...site, base_url: 'https://new.test' }] }, { measurement_version: null }]) {
      expect(comparableRuns(run, { ...run, ...patch }, 1)).toBe(false)
    }
  })
})
