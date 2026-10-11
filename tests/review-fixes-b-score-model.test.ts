import { describe, it, expect, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { upsertScoreModel, listScoreModels, ScoringError } from '@/lib/scoring/engine'

// Viktor's #74 Mediums: bad rules crashed the settings form (plain Error -> 500), and every
// save wiped max_points / thresholds that weren't posted.
describe('score model save: clear errors, omitted fields kept (#74)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  afterAll(async () => db?.close())

  it('bad rules are a ScoringError; omitted max_points and thresholds keep their values', async () => {
    db = await createTestDb()
    const eng = (await listScoreModels(db, { active_only: true })).find((m) => m.kind === 'engagement' && m.campaign_id == null)!
    const base = { id: eng.id, name: eng.name, entity: eng.entity, kind: eng.kind, campaign_id: eng.campaign_id }
    await expect(upsertScoreModel(db, 'owner', { ...base, rules: 'not an array' })).rejects.toThrow(ScoringError)
    await expect(upsertScoreModel(db, 'owner', { ...base, rules: [{ rule_key: 'x', event_type: 'reply_received' }] })).rejects.toThrow(ScoringError)

    await upsertScoreModel(db, 'owner', { ...base, rules: eng.rules, thresholds: [{ key: 'hot', label: 'Hot', min: 25 }], max_points: 40 })
    const saved = await upsertScoreModel(db, 'owner', { ...base, rules: eng.rules })
    expect(saved.max_points).toBe(40)
    expect(saved.thresholds).toEqual([{ key: 'hot', label: 'Hot', min: 25 }])
    const cleared = await upsertScoreModel(db, 'owner', { ...base, rules: eng.rules, max_points: null })
    expect(cleared.max_points).toBeNull()
  })
})
