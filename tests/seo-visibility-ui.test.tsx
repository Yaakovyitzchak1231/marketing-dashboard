// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }))
vi.mock('@/app/actions/seo', () => ({ addCompetitorAction: vi.fn(), addPromptAction: vi.fn(), removeCompetitorAction: vi.fn(), runVisibilityAction: vi.fn(), togglePromptAction: vi.fn(), runAuditAction: vi.fn() }))
vi.mock('@/lib/seo/store', () => ({ latestRuns: vi.fn(), listPrompts: vi.fn(), listCompetitors: vi.fn(), runResults: vi.fn(), latestAudits: vi.fn(), listFixTasks: vi.fn(), listSites: vi.fn() }))
import SeoVisibility from '@/app/seo/visibility/page'
import SeoOverview from '@/app/seo/page'
import { latestRuns, listCompetitors, listPrompts, runResults, latestAudits, listFixTasks, listSites, type PromptRow, type VisResult, type VisRun } from '@/lib/seo/store'

describe('SEO visibility results (rendered)', () => {
  const run: VisRun = {
    id: 1, provider: 'gemini', model: 'test-model', status: 'done', prompt_count: 4, measurement_version: 2,
    mentioned: 1, attempted: 4, answered: 2, failed: 1, unknown: 1,
    web_search: false, brand_terms: ['TapDash'], prompts: [], error: null,
    started_at: '2026-10-09T10:00:00.000Z', finished_at: '2026-10-09T10:01:00.000Z',
  }
  const prompts: PromptRow[] = [
    { id: 1, prompt: 'Q named', campaign: null, active: true },
    { id: 2, prompt: 'Q not named', campaign: null, active: true },
    { id: 3, prompt: 'Q empty', campaign: null, active: true },
    { id: 4, prompt: 'Q errored', campaign: null, active: true },
  ]
  const results: VisResult[] = [
    { id: 1, run_id: 1, prompt_id: 1, prompt: 'Q named', answer: 'TapDash is good', error: null, mentioned: true, text_mentioned: true, citation_urls: [], matched_terms: ['TapDash'], competitors: [], cited_urls: [] },
    { id: 2, run_id: 1, prompt_id: 2, prompt: 'Q not named', answer: 'Square.', error: null, mentioned: false, text_mentioned: false, citation_urls: [], matched_terms: [], competitors: ['Square'], cited_urls: [] },
    { id: 3, run_id: 1, prompt_id: 3, prompt: 'Q empty', answer: null, error: null, mentioned: null, matched_terms: [], competitors: [], cited_urls: [] },
    { id: 4, run_id: 1, prompt_id: 4, prompt: 'Q errored', answer: null, error: 'HTTP 500: boom', mentioned: null, matched_terms: [], competitors: [], cited_urls: [] },
  ]
  beforeEach(() => {
    vi.stubEnv('GEMINI_API_KEY', 'unit-test-placeholder')
    vi.mocked(latestRuns).mockResolvedValue([run])
    vi.mocked(listPrompts).mockResolvedValue(prompts)
    vi.mocked(listCompetitors).mockResolvedValue([])
    vi.mocked(runResults).mockResolvedValue(results)
    vi.mocked(latestAudits).mockResolvedValue(new Map())
    vi.mocked(listFixTasks).mockResolvedValue([])
    vi.mocked(listSites).mockResolvedValue([])
  })
  afterEach(() => vi.unstubAllEnvs())
  it('details divide by readable answers and show unanswered/error counts', async () => {
    render(await SeoVisibility({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText(/named in 1 of 2 answers/)).toHaveTextContent('1 unanswered · 1 error')
    expect(screen.queryByText(/named in 1 of 4/)).toBeNull()
    expect(screen.getAllByText('not named')).toHaveLength(1)
    expect(screen.getAllByText('unanswered')).toHaveLength(1)
    expect(screen.getByText(/error: HTTP 500: boom/)).toBeInTheDocument()
  })
  it('overview uses the same measured denominator and caveats', async () => {
    render(await SeoOverview({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText(/TapDash: named in 1 of 2 answers/)).toHaveTextContent('1 unanswered · 1 error')
    expect(screen.queryByText(/of 4 answers/)).toBeNull()
  })
  it('legacy counters can be reconstructed from result rows on the overview', async () => {
    vi.mocked(latestRuns).mockResolvedValue([{ ...run, answered: null, failed: null, unknown: null }])
    render(await SeoOverview({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText(/named in 1 of 2 answers/)).toBeInTheDocument()
  })
  it('missing historical results stay unavailable, not zero; running is not failed', async () => {
    vi.mocked(latestRuns).mockResolvedValue([{ ...run, answered: null, failed: null, unknown: null }])
    vi.mocked(runResults).mockResolvedValue([])
    const { unmount } = render(await SeoOverview({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText(/answer counts unavailable/)).toBeInTheDocument()
    unmount()
    vi.mocked(latestRuns).mockResolvedValue([{ ...run, status: 'running' }])
    render(await SeoVisibility({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText(/in progress/)).toBeInTheDocument()
  })
})
