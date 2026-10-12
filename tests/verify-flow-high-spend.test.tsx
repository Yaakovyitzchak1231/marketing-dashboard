// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { VerifyFlow } from '@/components/verify/VerifyFlow'
import type { RunRow } from '@/lib/verify/runs'

/**
 * Approving a ceiling above $500 takes a second, explicit click, and only that
 * second click sends `confirm_high_spend: true`. A ceiling at or below $500
 * is sent as before, with no flag.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }))

const preview: RunRow = {
  id: 7,
  status: 'preview',
  requested_by: 'owner',
  approved_by: null,
  contact_ids: [1, 2, 3],
  contact_count: 3,
  precheck_pass: 3,
  est_mv_checks: 3,
  est_zb_checks: 1,
  est_cost_usd: 0.03,
  max_cost_usd: null,
  spent_usd: 0,
  processed: 0,
  summary: null,
  created_at: '2026-10-12T12:00:00Z',
  approved_at: null,
  finished_at: null,
}

const done = { ...preview, status: 'done' as const, max_cost_usd: 1, processed: 3 }

function setup() {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ url, body })
    if (url.endsWith('/approve')) return new Response(JSON.stringify({ run: { ...preview, status: 'approved', max_cost_usd: body.max_cost_usd } }), { status: 200 })
    if (url.endsWith('/step')) return new Response(JSON.stringify({ run: done, done: true, paused: null, halted: null, processed_now: 3 }), { status: 200 })
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 })
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<VerifyFlow initialIds={[]} initialFilter={{}} initialRun={preview} keys={{ millionverifier: true, zerobounce: true }} />)
  const approveCalls = () => calls.filter((c) => c.url.endsWith('/approve'))
  return { calls, approveCalls }
}

const setCeiling = (v: string) => fireEvent.change(screen.getByLabelText(/Spend at most/), { target: { value: v } })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('VerifyFlow high-spend confirmation', () => {
  it('asks first for a ceiling above $500 and sends nothing yet', async () => {
    const { approveCalls } = setup()
    setCeiling('5000')
    fireEvent.click(screen.getByRole('button', { name: /Approve and run/ }))
    const ask = await screen.findByTestId('high-spend-confirm')
    expect(ask.textContent).toContain('$5000.00')
    expect(ask.textContent).toContain('Anything over $500.00 needs a second click')
    expect(approveCalls()).toHaveLength(0)
  })

  it('sends confirm_high_spend: true only after the second click', async () => {
    const { approveCalls } = setup()
    setCeiling('5000')
    fireEvent.click(screen.getByRole('button', { name: /Approve and run/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Yes, allow up to \$5000\.00/ }))
    await waitFor(() => expect(approveCalls()).toHaveLength(1))
    expect(approveCalls()[0].body).toEqual({ max_cost_usd: 5000, confirm_high_spend: true })
  })

  it('"Change the ceiling" cancels the question and sends nothing', async () => {
    const { approveCalls } = setup()
    setCeiling('900')
    fireEvent.click(screen.getByRole('button', { name: /Approve and run/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Change the ceiling' }))
    expect(screen.queryByTestId('high-spend-confirm')).toBeNull()
    expect(approveCalls()).toHaveLength(0)
  })

  it('editing the ceiling after the question drops the stale question', async () => {
    setup()
    setCeiling('900')
    fireEvent.click(screen.getByRole('button', { name: /Approve and run/ }))
    await screen.findByTestId('high-spend-confirm')
    setCeiling('50')
    expect(screen.queryByTestId('high-spend-confirm')).toBeNull()
  })

  it('a ceiling of exactly $500 is approved on the first click with no flag', async () => {
    const { approveCalls } = setup()
    setCeiling('500')
    fireEvent.click(screen.getByRole('button', { name: /Approve and run/ }))
    await waitFor(() => expect(approveCalls()).toHaveLength(1))
    expect(approveCalls()[0].body).toEqual({ max_cost_usd: 500 })
    expect(screen.queryByTestId('high-spend-confirm')).toBeNull()
  })

  it('the suggested ceiling (estimate + 20%) is approved on the first click with no flag', async () => {
    const { approveCalls } = setup()
    fireEvent.click(screen.getByRole('button', { name: /Approve and run/ }))
    await waitFor(() => expect(approveCalls()).toHaveLength(1))
    expect(approveCalls()[0].body).toEqual({ max_cost_usd: 0.04 })
  })
})
