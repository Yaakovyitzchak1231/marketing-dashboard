// listAiModelsAction is Owner-only (#98 review round 2): it sends the stored key to the configured host.
import { describe, it, expect, vi, beforeEach } from 'vitest'
const { role, fetchModelList } = vi.hoisted(() => ({ role: { v: 'editor' }, fetchModelList: vi.fn() }))
vi.mock('@/lib/auth/act', () => ({
  actorFor: async (min: string) => {
    if (min === 'owner' && role.v !== 'owner') throw new Error('forbidden')
    return role.v
  },
}))
vi.mock('@/lib/settings/store', () => ({ resolveConfig: async () => ({ value: 'https://api.example.com/v1' }) }))
vi.mock('@/lib/settings/models', () => ({ fetchModelList }))
import { listAiModelsAction } from '@/app/actions/ai-models'

describe('listAiModelsAction', () => {
  beforeEach(() => fetchModelList.mockReset().mockResolvedValue({ ok: true, models: ['m'] }))
  it('an Editor is refused and nothing is fetched', async () => {
    role.v = 'editor'
    expect(await listAiModelsAction()).toEqual({ ok: false, message: 'Only the Owner can load the AI model list.' })
    expect(fetchModelList).not.toHaveBeenCalled()
  })
  it('the Owner gets the list', async () => {
    role.v = 'owner'
    expect(await listAiModelsAction()).toEqual({ ok: true, models: ['m'] })
  })
})
