import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * A write on ideas, costs, or angles must also upsert one revisions row.
 * A delete that removed nothing must not invent a timeline event.
 */

const upsert = vi.fn((row: Record<string, unknown>) =>
  Promise.resolve({ data: null, error: null, row }),
)

function chain(result: { data?: unknown; error?: unknown }) {
  const built: Record<string, any> = {}
  const finish = () => Promise.resolve(result)
  built.eq = vi.fn(() => built)
  built.select = vi.fn(() => built)
  built.insert = vi.fn(() => built)
  built.update = vi.fn(() => built)
  built.delete = vi.fn(() => built)
  built.order = vi.fn(() => built)
  built.limit = vi.fn(() => built)
  built.upsert = upsert
  built.single = vi.fn(() => finish())
  built.maybeSingle = vi.fn(() => Promise.resolve({ data: { revision_number: 1 }, error: null }))
  built.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    finish().then(resolve, reject)
  return built
}

const mockClient = {
  from: vi.fn(),
  auth: {
    getUser: vi.fn(async () => ({
      data: { user: { email: 'yaakovytroutai@gmail.com' } },
      error: null,
    })),
  },
}

vi.mock('@/lib/request-client', () => ({
  getRequestClient: vi.fn(async () => mockClient),
}))

function post(path: string, body: Record<string, unknown>, actor?: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(actor ? { 'x-actor': actor } : {}),
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  upsert.mockClear()
  mockClient.from.mockReset()
})

describe('writes upsert a revisions row', () => {
  it('ideas POST records create revision 1 for the session email', async () => {
    const built = chain({ data: { id: 'idea-1' }, error: null })
    mockClient.from.mockImplementation(() => built)
    const { POST } = await import('@/app/api/ideas/route')
    const res = await POST(post('/api/ideas', { name: 'Try a subject' }))
    expect(res.status).toBe(201)
    expect(upsert).toHaveBeenCalledTimes(1)
    const row = upsert.mock.calls[0][0]
    expect(row.artifact_type).toBe('ideas')
    expect(row.artifact_id).toBe('idea-1')
    expect(row.revision_number).toBe(1)
    expect(row.change_kind).toBe('create')
    expect(row.actor).toBe('yaakovytroutai@gmail.com')
    expect(row.change_message).toBeNull()
    const inserted = built.insert.mock.calls[0][0]
    expect(inserted.revision_number).toBe(1)
    expect(inserted.actor).toBe('yaakovytroutai@gmail.com')
  })

  it('costs POST records a revision and does not invent a change message', async () => {
    const built = chain({ data: { id: 'cost-1' }, error: null })
    mockClient.from.mockImplementation(() => built)
    const { POST } = await import('@/app/api/costs/route')
    const res = await POST(post('/api/costs', { amount_usd: 12, category: 'tool' }))
    expect(res.status).toBe(201)
    const row = upsert.mock.calls[0][0]
    expect(row.artifact_type).toBe('costs')
    expect(row.artifact_id).toBe('cost-1')
    expect(row.revision_number).toBe(1)
    expect(row.change_kind).toBe('create')
    expect(row.change_message).toBeNull()
  })

  it('angles POST records a revision', async () => {
    const built = chain({ data: { id: 'angle-1' }, error: null })
    mockClient.from.mockImplementation(() => built)
    const { POST } = await import('@/app/api/angles/route')
    const res = await POST(post('/api/angles', { name: 'Direct ask' }))
    expect(res.status).toBe(201)
    expect(upsert.mock.calls[0][0].artifact_type).toBe('angles')
    expect(upsert.mock.calls[0][0].change_kind).toBe('create')
  })

  it('fleet writes are actor agent:<profile>, not a spoofed email', async () => {
    const built = chain({ data: { id: 'idea-2' }, error: null })
    mockClient.from.mockImplementation(() => built)
    const { POST } = await import('@/app/api/ideas/route')
    const res = await POST(post('/api/ideas', { name: 'Fleet draft' }, 'agent:build-data'))
    expect(res.status).toBe(201)
    expect(upsert.mock.calls[0][0].actor).toBe('agent:build-data')
  })

  it('PUT on an idea upserts an update revision numbered from the stored value', async () => {
    const built = chain({ data: { id: 'idea-1', title: 'Renamed' }, error: null })
    mockClient.from.mockImplementation(() => built)
    const { PUT } = await import('@/app/api/ideas/[id]/route')
    const req = new NextRequest('http://localhost/api/ideas/idea-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed', change_message: 'tightened the hypothesis' }),
    })
    const res = await PUT(req, { params: Promise.resolve({ id: 'idea-1' }) })
    expect(res.status).toBe(200)
    const row = upsert.mock.calls[0][0]
    expect(row.change_kind).toBe('update')
    expect(row.revision_number).toBe(2)
    expect(row.change_message).toBe('tightened the hypothesis')
    expect(row.artifact_id).toBe('idea-1')
  })

  it('a delete that removed nothing does not write a revision', async () => {
    const built = chain({ data: [], error: null })
    mockClient.from.mockImplementation(() => built)
    const { DELETE } = await import('@/app/api/ideas/[id]/route')
    const req = new NextRequest('http://localhost/api/ideas/missing', { method: 'DELETE' })
    const res = await DELETE(req, { params: Promise.resolve({ id: 'missing' }) })
    expect(res.status).toBe(404)
    expect(upsert).not.toHaveBeenCalled()
  })
})
