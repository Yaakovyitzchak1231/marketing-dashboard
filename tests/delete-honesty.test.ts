import { describe, it, expect, vi, beforeEach } from 'vitest'

// A DELETE that RLS filtered out to zero rows is NOT an error in Postgres: the
// row is simply invisible, so the statement matches nothing and returns a null
// error. Before this regression test, all three DELETE routes checked only
// `error` and therefore answered {"ok": true} for a delete that removed
// nothing. That is the exact dishonesty the dashboard is not allowed to ship.
//
// These tests pin the contract: the route must inspect the returned rows and
// report a 404 when nothing was removed.

const mockClient = {
  from: vi.fn(),
}

vi.mock('@/lib/request-client', () => ({
  getRequestClient: vi.fn(async () => mockClient),
}))

function chain(result: { data?: unknown; error?: unknown }) {
  const built: Record<string, unknown> = {}
  built.eq = vi.fn(() => built)
  built.select = vi.fn(() => Promise.resolve(result))
  built.delete = vi.fn(() => built)
  built.single = vi.fn(() => Promise.resolve(result))
  return built
}

async function callDelete(route: string, id: string) {
  const mod = await import(route)
  const req = { cookies: () => new Map() } as never
  const res = await mod.DELETE(req, { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DELETE reports honestly when RLS hides the row', () => {
  it('ideas: 404 when the delete removed zero rows', async () => {
    mockClient.from = vi.fn(() => chain({ data: [], error: null }))
    const { status, body } = await callDelete('@/app/api/ideas/[id]/route', 'abc')
    expect(status).toBe(404)
    expect(body.error).toMatch(/not found/i)
    expect(body.ok).toBeUndefined()
  })

  it('costs: 404 when the delete removed zero rows', async () => {
    mockClient.from = vi.fn(() => chain({ data: [], error: null }))
    const { status, body } = await callDelete('@/app/api/costs/[id]/route', 'abc')
    expect(status).toBe(404)
    expect(body.error).toMatch(/not found/i)
  })

  it('angles: 404 when the delete removed zero rows', async () => {
    mockClient.from = vi.fn(() => chain({ data: [], error: null }))
    const { status, body } = await callDelete('@/app/api/angles/[id]/route', 'abc')
    expect(status).toBe(404)
    expect(body.error).toMatch(/not found/i)
  })

  it('ideas: 200 ok when a row really was removed', async () => {
    mockClient.from = vi.fn(() => chain({ data: [{ id: 'abc' }], error: null }))
    const { status, body } = await callDelete('@/app/api/ideas/[id]/route', 'abc')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
  })

  it('ideas: 500 when Postgres itself errors', async () => {
    mockClient.from = vi.fn(() =>
      chain({ data: null, error: { code: '42501', message: 'permission denied' } }),
    )
    const { status } = await callDelete('@/app/api/ideas/[id]/route', 'abc')
    expect(status).toBe(500)
  })

  it('the delete chain actually asks for the affected rows', async () => {
    // Without .select('id') the response carries no row count, so the route
    // cannot distinguish "deleted one" from "matched nothing".
    const built = chain({ data: [{ id: 'abc' }], error: null })
    mockClient.from = vi.fn(() => built)
    await callDelete('@/app/api/ideas/[id]/route', 'abc')
    expect(built.delete).toHaveBeenCalled()
    expect(built.select).toHaveBeenCalledWith('id')
  })
})
