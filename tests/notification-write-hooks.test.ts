import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ db: {}, kick: vi.fn(), find: vi.fn(), research: vi.fn(), update: vi.fn(), task: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => mocks.db }))
vi.mock('@/lib/notify/kick', () => ({ kickDelivery: mocks.kick }))
vi.mock('@/lib/engine/jobs', () => ({ createFindJob: mocks.find, enqueueResearch: mocks.research, listFindJobs: vi.fn() }))
vi.mock('@/lib/seo/store', () => ({ getFixTask: mocks.task }))
vi.mock('@/lib/ops/core', async (original) => ({ ...await original<object>(), updateTask: mocks.update }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))
import { POST as find } from '@/app/api/find/jobs/route'
import { POST as research } from '@/app/api/research/enqueue/route'
import { updateFixAction } from '@/app/actions/seo'

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
  it('SEO assignment kicks before redirecting', async () => {
    const f = new FormData()
    f.set('task_id', '1'); f.set('op', 'assign'); f.set('assigned_to', 'tab')
    await expect(updateFixAction(f)).rejects.toThrow('redirect:/seo/todos')
    expect(mocks.update).toHaveBeenCalledWith(mocks.db, 'owner', 1, { assigned_to: 'tab' })
    expect(mocks.kick).toHaveBeenCalledWith(mocks.db)
  })
})
