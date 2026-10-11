// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }))
vi.mock('@/app/actions/seo', () => ({ queueCitationAction: vi.fn() }))
vi.mock('@/lib/seo/store', () => ({ listSites: vi.fn() }))
vi.mock('@/lib/seo/citations', async (original) => ({ ...await original<typeof import('@/lib/seo/citations')>(), loadCitationReport: vi.fn() }))
import SeoCitations from '@/app/seo/citations/page'
import { listSites, type SiteRow, type VisRun, type VisResult } from '@/lib/seo/store'
import { loadCitationReport } from '@/lib/seo/citations'
const site: SiteRow = { id: 1, name: 'TapDash', base_url: 'https://tapdash.co', platform: 'wordpress', host: null, campaign: 'jewelers', brand_terms: ['TapDash'], pages: [], active: true, notes: null, created_at: '2026-10-09' }
const run: VisRun = { id: 3, provider: 'perplexity', model: 'fixture-model', measurement_version: 2, site_snapshot: [site], status: 'done', prompt_count: 2, mentioned: 1, attempted: 2, answered: 2, failed: 0, unknown: 0, web_search: true, brand_terms: ['TapDash'], prompts: [{ prompt_id: 1, prompt: 'Question?' }], error: null, started_at: '2026-10-09', finished_at: '2026-10-09' }
const row: VisResult = { id: 9, run_id: 3, prompt_id: 1, prompt: 'Question?', answer: 'TapDash may be an option.', error: null, mentioned: true, text_mentioned: true, matched_terms: ['TapDash'], competitors: [], cited_urls: [], citation_urls: ['https://other.test/evidence'], retrieved_urls: ['https://tapdash.co/jewelers/'] }

describe('citation evidence screen (rendered DOM)', () => {
  beforeEach(() => {
    vi.mocked(listSites).mockResolvedValue([site])
    vi.mocked(loadCitationReport).mockResolvedValue({ site, runs: [run], selected: run, previous: null, results: [row] })
  })
  afterEach(() => cleanup())
  it('separates mentions from citations and exposes evidence-backed task buttons', async () => {
    render(await SeoCitations({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText('1 of 1 answers')).toBeInTheDocument()
    expect(screen.getByText('0 of 1 answers')).toBeInTheDocument()
    expect(screen.getByText(/Retrieved sources — not counted/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://tapdash.co/jewelers/' })).toHaveAttribute('href', 'https://tapdash.co/jewelers/')
    expect(screen.getByRole('button', { name: 'Queue content review' })).toHaveAttribute('value', 'review')
    expect(screen.getByRole('button', { name: 'Prepare WordPress draft task' })).toHaveAttribute('value', 'draft')
    expect(screen.getByText(/not consumer-app rankings/)).toBeInTheDocument()
    expect(screen.getByText(/No previous comparable run/)).toBeInTheDocument()
  })
  it('failed or unknown answers cannot generate tasks or a zero citation measurement', async () => {
    vi.mocked(loadCitationReport).mockResolvedValue({ site, runs: [run], selected: run, previous: null, results: [{ ...row, answer: null, mentioned: null, text_mentioned: null, citation_urls: null }] })
    render(await SeoCitations({ searchParams: Promise.resolve({}) }))
    expect(screen.getAllByText('Unavailable')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Queue content review' })).toBeNull()
    expect(screen.queryByText('0 of 0 answers')).toBeNull()
  })
  it('a new site explains why legacy evidence cannot be classified', async () => {
    vi.mocked(loadCitationReport).mockResolvedValue({ site, runs: [], selected: null, previous: null, results: [] })
    render(await SeoCitations({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText(/No citation-separated runs/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Run an AI visibility check' })).toHaveAttribute('href', '/seo/visibility')
  })
  it('paused sites retain evidence but cannot queue work', async () => {
    vi.mocked(loadCitationReport).mockResolvedValue({ site: { ...site, active: false }, runs: [run], selected: run, previous: null, results: [row] })
    render(await SeoCitations({ searchParams: Promise.resolve({}) }))
    expect(screen.queryByRole('button', { name: 'Queue content review' })).toBeNull()
    expect(screen.getByText(/Task creation is unavailable/)).toBeInTheDocument()
  })
  it('database failure says unavailable, without measurements or action buttons', async () => {
    vi.mocked(loadCitationReport).mockRejectedValue(new Error('offline'))
    render(await SeoCitations({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText(/No measurements are shown/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Queue content review' })).toBeNull()
  })
})
