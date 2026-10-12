/**
 * Collab write routes: fail-closed input validation and actor honesty.
 *
 * The provenance panel POSTs to /api/approvals and /api/comments. These tests
 * pin the contract at the route level: bad artifact types are rejected before
 * any row is touched, empty payloads are rejected, and the actor/author is
 * the session email or NULL — never a client-supplied value.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const sessionEmailMock = vi.fn()

vi.mock('@/lib/request-client', () => ({
  getRequestClient: vi.fn(),
}))

vi.mock('@/lib/revisions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/revisions')>()
  return {
    ...actual,
    sessionEmail: (...args: unknown[]) => sessionEmailMock(...args),
  }
})

import { getRequestClient } from '@/lib/request-client'
import { GET as approvalsGET, POST as approvalsPOST } from '@/app/api/approvals/route'
import { GET as commentsGET, POST as commentsPOST } from '@/app/api/comments/route'
import { GET as checkpointsGET, POST as checkpointsPOST } from '@/app/api/checkpoints/route'

const getClient = getRequestClient as unknown as ReturnType<typeof vi.fn>

function req(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(url, init)
}

function jsonReq(url: string, body: unknown): NextRequest {
  return req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function chain(result: { data: unknown; error: null }) {
  const order: Record<string, unknown> = {}
  order['order'] = vi.fn().mockResolvedValue(result)
  const eq2: Record<string, unknown> = {}
  eq2['eq'] = vi.fn().mockReturnValue(order)
  const eq1: Record<string, unknown> = {}
  eq1['eq'] = vi.fn().mockReturnValue(eq2)
  const select: Record<string, unknown> = {}
  select['select'] = vi.fn().mockReturnValue(eq1)
  return select
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionEmailMock.mockResolvedValue('yaakovytroutai@gmail.com')
})

describe('approvals route', () => {
  it('rejects an unknown artifact_type with 400', async () => {
    getClient.mockResolvedValue(chain({ data: [], error: null }))
    const res = await approvalsGET(req('http://x/api/approvals?artifact_type=nope&artifact_id=1'))
    expect(res.status).toBe(400)
  })

  it('requires artifact_id with 400', async () => {
    getClient.mockResolvedValue(chain({ data: [], error: null }))
    const res = await approvalsGET(req('http://x/api/approvals?artifact_type=ideas'))
    expect(res.status).toBe(400)
  })

  it('rejects an unknown status with 400', async () => {
    const inserted: Record<string, unknown>[] = []
    getClient.mockResolvedValue({
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push(row)
          return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }
        },
      }),
    })
    const res = await approvalsPOST(
      jsonReq('http://x/api/approvals', {
        artifact_type: 'ideas',
        artifact_id: 'c4f4',
        status: 'maybe',
      }),
    )
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('records the session email as actor, never a client value', async () => {
    const inserted: Record<string, unknown>[] = []
    getClient.mockResolvedValue({
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push(row)
          return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }
        },
      }),
    })
    const res = await approvalsPOST(
      jsonReq('http://x/api/approvals', {
        artifact_type: 'ideas',
        artifact_id: 'c4f4',
        status: 'approved',
        actor: 'someone-else@example.com',
      }),
    )
    expect(res.status).toBe(201)
    expect(inserted[0]?.actor).toBe('yaakovytroutai@gmail.com')
  })
})

describe('comments route', () => {
  it('rejects an unknown artifact_type with 400', async () => {
    getClient.mockResolvedValue(chain({ data: [], error: null }))
    const res = await commentsGET(req('http://x/api/comments?artifact_type=nope&artifact_id=1'))
    expect(res.status).toBe(400)
  })

  it('rejects empty text with 400 and writes nothing', async () => {
    const inserted: Record<string, unknown>[] = []
    getClient.mockResolvedValue({
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push(row)
          return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }
        },
      }),
    })
    const res = await commentsPOST(
      jsonReq('http://x/api/comments', {
        artifact_type: 'ideas',
        artifact_id: 'c4f4',
        text: '   ',
      }),
    )
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('records the session email as author', async () => {
    const inserted: Record<string, unknown>[] = []
    getClient.mockResolvedValue({
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push(row)
          return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }
        },
      }),
    })
    const res = await commentsPOST(
      jsonReq('http://x/api/comments', {
        artifact_type: 'ideas',
        artifact_id: 'c4f4',
        row_name: 'Idea',
        text: 'A human voice.',
      }),
    )
    expect(res.status).toBe(201)
    expect(inserted[0]?.author).toBe('yaakovytroutai@gmail.com')
  })
})

describe('checkpoints route', () => {
  it('rejects an unknown artifact_type with 400', async () => {
    getClient.mockResolvedValue(chain({ data: [], error: null }))
    const res = await checkpointsGET(req('http://x/api/checkpoints?artifact_type=nope&artifact_id=1'))
    expect(res.status).toBe(400)
  })

  it('requires artifact_id with 400 and writes nothing', async () => {
    const inserted: Record<string, unknown>[] = []
    getClient.mockResolvedValue({
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push(row)
          return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }
        },
      }),
    })
    const res = await checkpointsPOST(
      jsonReq('http://x/api/checkpoints', { artifact_type: 'ideas' }),
    )
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('pins with the session email as actor', async () => {
    const inserted: Record<string, unknown>[] = []
    getClient.mockResolvedValue({
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push(row)
          return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }
        },
      }),
    })
    const res = await checkpointsPOST(
      jsonReq('http://x/api/checkpoints', {
        artifact_type: 'ideas',
        artifact_id: 'c4f4',
        revision_number: 2,
      }),
    )
    expect(res.status).toBe(201)
    expect(inserted[0]).toMatchObject({
      artifact_type: 'ideas',
      artifact_id: 'c4f4',
      revision_number: 2,
      name: 'Pin revision 2',
      actor: 'yaakovytroutai@gmail.com',
    })
  })
})

describe('approvals duplicate', () => {
  it('returns 409 with an honest message when the decision exists', async () => {
    const { POST } = await import('@/app/api/approvals/route')
    getClient.mockResolvedValue({
      from: () => ({
        insert: () => ({
          select: () => ({
            single: () =>
              Promise.resolve({
                data: null,
                error: { code: '23505', message: 'duplicate key value' },
              }),
          }),
        }),
      }),
    })
    const res = await POST(
      jsonReq('http://x/api/approvals', {
        artifact_type: 'ideas',
        artifact_id: 'c4f4',
        status: 'approved',
      }),
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'This decision is already recorded for this row.',
    })
  })
})
