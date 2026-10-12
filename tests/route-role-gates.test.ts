import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * The mutating API routes that used to rely on the middleware alone (and wrote
 * every change as the literal actor 'owner') now check the role themselves,
 * first. With no database connected, a caller who lacks the role must still
 * get 403, and a caller who has it must get past the gate (503 from the
 * "database not connected" check that comes next), so the gate is provably
 * the first thing each handler does.
 */
const holder = vi.hoisted(() => ({ role: null as string | null, actor: 'ed' }))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock('@/lib/db', () => ({ getDb: () => null, dbConfigured: () => false }))
vi.mock('@/lib/request-client', () => ({ getRequestClient: async () => null }))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => holder.role,
  currentActorId: async () => holder.actor,
  currentEmail: async () => null,
}))

import { POST as approvalsPost } from '@/app/api/approvals/route'
import { POST as checkpointsPost } from '@/app/api/checkpoints/route'
import { POST as restorePost } from '@/app/api/checkpoints/restore/route'
import { POST as commentsPost } from '@/app/api/comments/route'
import { POST as revisionsPost } from '@/app/api/revisions/route'
import { POST as findCancel } from '@/app/api/find/jobs/[id]/cancel/route'
import { POST as findCreate } from '@/app/api/find/jobs/route'
import { POST as leadComment } from '@/app/api/leads/[id]/comments/route'
import { PATCH as contactPatch } from '@/app/api/leads/[id]/contacts/[contactId]/route'
import { POST as ownerResearch } from '@/app/api/leads/[id]/owner-research/route'
import { PATCH as leadPatch } from '@/app/api/leads/[id]/route'
import { PATCH as bulkEdit } from '@/app/api/leads/bulk-edit/route'
import { POST as listsPost } from '@/app/api/leads/lists/route'
import { POST as segmentPreview } from '@/app/api/leads/segments/preview/route'
import { POST as segmentsPost } from '@/app/api/leads/segments/route'
import { PATCH as stagePatch } from '@/app/api/leads/stage/route'
import { POST as enqueue } from '@/app/api/research/enqueue/route'
import { POST as recompute } from '@/app/api/rules/[id]/recompute/route'
import { PUT as rulePut, DELETE as ruleDelete } from '@/app/api/rules/[id]/route'
import { POST as proposalPost } from '@/app/api/rules/proposals/[approvalId]/route'
import { POST as rulesPost } from '@/app/api/rules/route'
import { GET as stepsGet, POST as stepsPost, PATCH as stepsPatch, PUT as stepsPut, DELETE as stepsDelete } from '@/app/api/campaign-steps/[campaignId]/[[...path]]/route'

const body = (method: string) =>
  method === 'GET' ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }
const nreq = (method: string) => new NextRequest('http://localhost/api/x', body(method))
const req = (method: string) => new Request('http://localhost/api/x', body(method))
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) })

const WRITES: [string, () => Promise<Response>][] = [
  ['POST /api/approvals', () => approvalsPost(nreq('POST'))],
  ['POST /api/checkpoints', () => checkpointsPost(nreq('POST'))],
  ['POST /api/checkpoints/restore', () => restorePost(nreq('POST'))],
  ['POST /api/comments', () => commentsPost(nreq('POST'))],
  ['POST /api/revisions', () => revisionsPost(nreq('POST'))],
  ['POST /api/find/jobs/:id/cancel', () => findCancel(req('POST'), p({ id: '1' }))],
  ['POST /api/find/jobs', () => findCreate(req('POST'))],
  ['POST /api/leads/:id/comments', () => leadComment(req('POST'), p({ id: '1' }))],
  ['PATCH /api/leads/:id/contacts/:contactId', () => contactPatch(req('PATCH'), p({ id: '1', contactId: '1' }))],
  ['POST /api/leads/:id/owner-research', () => ownerResearch(req('POST'), p({ id: '1' }))],
  ['PATCH /api/leads/:id', () => leadPatch(req('PATCH'), p({ id: '1' }))],
  ['PATCH /api/leads/bulk-edit', () => bulkEdit(req('PATCH'))],
  ['POST /api/leads/lists', () => listsPost(req('POST'))],
  ['POST /api/leads/segments', () => segmentsPost(req('POST'))],
  ['PATCH /api/leads/stage', () => stagePatch(req('PATCH'))],
  ['POST /api/research/enqueue', () => enqueue(req('POST'))],
  ['POST /api/rules/:id/recompute', () => recompute(req('POST'), p({ id: '1' }))],
  ['PUT /api/rules/:id', () => rulePut(req('PUT'), p({ id: '1' }))],
  ['DELETE /api/rules/:id', () => ruleDelete(req('DELETE'), p({ id: '1' }))],
  ['POST /api/rules/proposals/:approvalId', () => proposalPost(req('POST'), p({ approvalId: '1' }))],
  ['POST /api/rules', () => rulesPost(req('POST'))],
  ['POST /api/campaign-steps/:campaignId', () => stepsPost(req('POST'), p({ campaignId: '1' }))],
  ['PATCH /api/campaign-steps/:campaignId/:step', () => stepsPatch(req('PATCH'), p({ campaignId: '1', path: '2' } as never))],
  ['PUT /api/campaign-steps/:campaignId/instantly', () => stepsPut(req('PUT'), p({ campaignId: '1' }))],
  ['DELETE /api/campaign-steps/:campaignId/:step', () => stepsDelete(req('DELETE'), p({ campaignId: '1' }))],
]

describe('editor-level write routes check the role before anything else', () => {
  beforeEach(() => {
    holder.role = null
    holder.actor = 'ed'
  })

  it.each(WRITES)('%s: signed-out and viewer get 403', async (_name, call) => {
    for (const role of [null, 'viewer']) {
      holder.role = role
      const r = await call()
      expect(r.status).toBe(403)
      const json = (await r.json()) as { error?: string }
      expect(json.error).toMatch(role ? /editor access/ : /Not signed in/)
    }
  })

  it.each(WRITES)('%s: an editor and an owner get past the gate', async (_name, call) => {
    for (const role of ['editor', 'owner']) {
      holder.role = role
      const r = await call()
      expect(r.status, `${role}`).not.toBe(403)
    }
  })
})

describe('read-level routes', () => {
  beforeEach(() => {
    holder.role = 'viewer'
  })

  it('the segment preview count (a read that is a POST) admits any signed-in role but not a signed-out caller', async () => {
    holder.role = null
    expect((await segmentPreview(req('POST'))).status).toBe(403)
    holder.role = 'viewer'
    expect((await segmentPreview(req('POST'))).status).not.toBe(403)
  })

  it('campaign step reads need only a signed-in role; every write method needs an editor', async () => {
    holder.role = 'viewer'
    expect((await stepsGet(req('GET'), p({ campaignId: '1' }))).status).not.toBe(403)
    expect((await stepsPost(req('POST'), p({ campaignId: '1' }))).status).toBe(403)
    holder.role = null
    expect((await stepsGet(req('GET'), p({ campaignId: '1' }))).status).toBe(403)
  })
})
