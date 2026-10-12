import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ExperimentsPanel } from '@/components/campaign-steps/ExperimentsPanel'
import { outcomeFormFor, parseVariantInput } from '@/lib/experiments/form'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const experiment = {
  id: 4, campaign_id: 7, step_number: 1, name: 'Subject test', status: 'running',
  config: { variants: [{ key: 'X', weight: 50 }, { key: 'Y', weight: 50 }], auto_winner: true, min_sends_per_variant: 100 },
  winner_variant: null, decided_at: null,
}
const detail = { ...experiment, outcomes: [{ variant: 'X', sends: 200, positive_replies: 20 }, { variant: 'Y', sends: 0, positive_replies: 0 }], assignments: 1234 }

describe('ExperimentsPanel outcome form', () => {
  it('submits the variant the select shows (the first configured variant), not a hard-coded A', async () => {
    const calls: { url: string; method: string; body: unknown }[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.endsWith('/experiments') && init?.method === 'GET') return new Response(JSON.stringify({ ok: true, experiments: [experiment] }), { status: 200 })
      if (url.endsWith('/experiments/4') && init?.method === 'GET') return new Response(JSON.stringify({ ok: true, ...detail }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, outcome: {} }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ExperimentsPanel campaignId={7} stepNumbers={[1]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Results' }))
    const variant = (await screen.findByLabelText('Variant')) as HTMLSelectElement
    expect(variant.value).toBe('X')
    // type in Sends and Positive replies WITHOUT touching the select
    fireEvent.change(screen.getByLabelText('Sends'), { target: { value: '50' } })
    fireEvent.change(screen.getByLabelText('Positive replies'), { target: { value: '4' } })
    expect((screen.getByLabelText('Variant') as HTMLSelectElement).value).toBe('X')
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/outcome'))).toBe(true))
    const post = calls.find((c) => c.url.endsWith('/outcome'))!
    expect(post.method).toBe('POST')
    expect(post.body).toEqual({ variant: 'X', sends: 50, positive_replies: 4 })
    // counts are formatted by the shared formatter, and a 0-send variant has no rate (a dash, not 0%)
    expect(screen.getByText('1,234 leads assigned')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getByText('10.0%')).toBeInTheDocument()
  })

  it('submits a different variant after the person picks it', async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.endsWith('/experiments') && init?.method === 'GET') return new Response(JSON.stringify({ ok: true, experiments: [experiment] }), { status: 200 })
      if (url.endsWith('/experiments/4') && init?.method === 'GET') return new Response(JSON.stringify({ ok: true, ...detail }), { status: 200 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }))
    render(<ExperimentsPanel campaignId={7} stepNumbers={[1]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Results' }))
    fireEvent.change(await screen.findByLabelText('Variant'), { target: { value: 'Y' } })
    fireEvent.change(screen.getByLabelText('Sends'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/outcome'))).toBe(true))
    expect(calls.find((c) => c.url.endsWith('/outcome'))!.body).toEqual({ variant: 'Y', sends: 30 })
  })

  it('refuses a variant list with a bad key before sending anything', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, experiments: [] }), { status: init?.method === 'GET' ? 200 : 201 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ExperimentsPanel campaignId={7} stepNumbers={[1]} />)
    await screen.findByText(/No experiments yet/)
    fireEvent.change(screen.getByPlaceholderText('e.g. Subject line test'), { target: { value: 'T' } })
    fireEvent.change(screen.getByPlaceholderText('A:50, B:50'), { target: { value: 'A:50, B x:50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/not a valid variant key/)
    expect(fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0)
  })
})

describe('experiment form helpers (pure)', () => {
  it('outcomeFormFor defaults to the first configured variant, or blank when there are none', () => {
    expect(outcomeFormFor({}, { id: 1, config: { variants: [{ key: 'X' }, { key: 'Y' }] } }).variant).toBe('X')
    expect(outcomeFormFor({}, { id: 1, config: { variants: [] } }).variant).toBe('')
    expect(outcomeFormFor({ 1: { variant: 'Y', sends: '3', replies: '' } }, { id: 1, config: { variants: [{ key: 'X' }] } }).variant).toBe('Y')
  })
  it('parseVariantInput accepts key:weight pairs and rejects colons in keys, bad weights, duplicates, and fewer than two', () => {
    expect(parseVariantInput('A:50, B:50')).toEqual({ variants: [{ key: 'A', weight: 50 }, { key: 'B', weight: 50 }], error: null })
    expect(parseVariantInput('subj_1:1, subj-2:3').error).toBeNull()
    expect(parseVariantInput('A:B:50, C:1').error).toMatch(/key:weight/)
    expect(parseVariantInput('A, B:1').error).toMatch(/key:weight/)
    expect(parseVariantInput('A b:1, C:1').error).toMatch(/not a valid variant key/)
    expect(parseVariantInput('A:0, B:1').error).toMatch(/weight/)
    expect(parseVariantInput('A:x, B:1').error).toMatch(/weight/)
    expect(parseVariantInput('A:1, a:1').error).toMatch(/twice/)
    expect(parseVariantInput('A:1').error).toMatch(/at least two/)
  })
})
