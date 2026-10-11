import { describe, it, expect, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { getPreset, presetSegmentInput } from '@/lib/segments/presets'
import { createSegment } from '@/lib/segments/store'

// Review fix (#80, Viktor): "Start from template" worked once per preset and
// then always failed on segments_preset_key_uq.
describe('start from template can be used again (#80)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  afterAll(async () => db?.close())

  it('the same template can be used twice, for the same and for another campaign', async () => {
    db = await createTestDb()
    const preset = getPreset('engaged')!
    expect(preset).toBeTruthy()
    const { rows } = await db.query<{ id: number }>(`insert into lp.campaigns (name, pool) values ('A', 'jeweler'), ('B', 'jeweler') returning id`)
    const [c1, c2] = [rows[0].id, rows[1].id]
    const a = await db.tx((q) => createSegment(q, 'owner', presetSegmentInput(preset, c1), 'ui'), 'owner')
    const b = await db.tx((q) => createSegment(q, 'owner', presetSegmentInput(preset, c1), 'ui'), 'owner')
    const c = await db.tx((q) => createSegment(q, 'owner', presetSegmentInput(preset, c2), 'ui'), 'owner')
    expect(new Set([a.id, b.id, c.id]).size).toBe(3)
    for (const s of [a, b, c]) {
      expect(s.is_preset).toBe(true)
      expect(s.preset_key).toBeNull()
      expect(s.name).toBe(preset.label)
    }
  })
})
