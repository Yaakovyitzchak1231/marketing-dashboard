import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ db: {}, kick: vi.fn(), find: vi.fn(), research: vi.fn(), update: vi.fn(), task: vi.fn(), citation: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => mocks.db }))
vi.mock('@/lib/notify/kick', () => ({ kickDelivery: mocks.kick }))
vi.mock('@/lib/engine/jobs', () => ({ createFindJob: mocks.find, enqueueResearch: mocks.research, listFindJobs: vi.fn() }))
vi.mock('@/lib/seo/store', () => ({ getFixTask: mocks.task }))
vi.mock('@/lib/seo/citations', () => ({ createCitationTask: mocks.citation }))
vi.mock('@/lib/ops/core', async (original) => ({ ...await original<object>(), updateTask: mocks.update }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
// The SEO actions now check the role and record the signed-in person (actorFor).
vi.mock('@/lib/auth/session', () => ({ currentRole: async () => 'owner', currentActorId: async () => 'owner', currentEmail: async () => null }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))
import { POST as find } from '@/app/api/find/jobs/route'
import { POST as research } from '@/app/api/research/enqueue/route'
import { updateFixAction, queueCitationAction } from '@/app/actions/seo'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.find.mockResolvedValue({ id: 1 })
  mocks.research.mockResolvedValue({ queued: [{ company_id: 1, task_id: 1 }], already: [], missing: [] })
  mocks.task.mockResolvedValue({ id: 1, status: 'queued' })
  mocks.update.mockResolvedValue({ id: 1 })
})
const request = (body: unknown) => new Request('https://dashboard.example', { method: 'POST', body: JSON.stringify(body) })
describe('task creation schedules immediate delivery after saving', () => {
  it('Find leads kicks after creating the task', async () => {
    expect((await find(request({ states: ['MD'] }))).status).toBe(201)
    expect(mocks.kick).toHaveBeenCalledWith(mocks.db)
    expect(mocks.find.mock.invocationCallOrder[0]).toBeLessThan(mocks.kick.mock.invocationCallOrder[0])
  })
  it('Research selected kicks after creating its tasks', async () => {
    expect((await research(request({ company_ids: [1], assigned_to: 'tab' }))).status).toBe(200)
    expect(mocks.kick).toHaveBeenCalledWith(mocks.db)
    expect(mocks.research.mock.invocationCallOrder[0]).toBeLessThan(mocks.kick.mock.invocationCallOrder[0])
  })
  it('invalid input does not schedule delivery', async () => {
    expect((await research(request({ company_ids: [] }))).status).toBe(400)
    expect(mocks.kick).not.toHaveBeenCalled()
  })
  it('citation review queues only stored evidence IDs and redirects to its task', async () => {
    mocks.citation.mockResolvedValue({ id: 42, created: true })
    const f = new FormData()
    f.set('site_id', '1'); f.set('result_id', '9'); f.set('mode', 'review')
    f.set('return_to', 'https://outside.test')
    await expect(queueCitationAction(f)).rejects.toThrow('redirect:/seo/todos/42')
    expect(mocks.citation).toHaveBeenCalledWith(mocks.db, 'owner', { site_id: 1, result_id: 9, mode: 'review' })
    expect(mocks.kick).toHaveBeenCalledWith(mocks.db)
  })
  it('invalid citation inputs cannot create work', async () => {
    const f = new FormData()
    f.set('site_id', '1'); f.set('result_id', '9'); f.set('mode', 'publish')
    await expect(queueCitationAction(f)).rejects.toThrow('redirect:/seo/citations?err=')
    expect(mocks.citation).not.toHaveBeenCalled()
    expect(mocks.kick).not.toHaveBeenCalled()
  })
  it('SEO assignment kicks before redirecting', async () => {
    const f = new FormData()
    f.set('task_id', '1'); f.set('op', 'assign'); f.set('assigned_to', 'tab')
    await expect(updateFixAction(f)).rejects.toThrow('redirect:/seo/todos')
    expect(mocks.update).toHaveBeenCalledWith(mocks.db, 'owner', 1, { assigned_to: 'tab' })
    expect(mocks.kick).toHaveBeenCalledWith(mocks.db)
  })
})
