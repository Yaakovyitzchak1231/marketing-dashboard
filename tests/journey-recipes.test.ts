import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { GOALS, goalKey, goalLabel } from '@/lib/journeys/goals'
import { getRecipe, instantiateRecipe, listRecipes, RecipeError } from '@/lib/journeys/recipes'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

// The shared box is slow; PGlite boots a full Postgres per test.
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 })

const ACTOR = 'owner'

describe('journey goals', () => {
  it('maps keys and labels to display labels', () => {
    expect(GOALS.length).toBeGreaterThanOrEqual(4)
    expect(goalLabel('book_meetings')).toBe('Book meetings')
    expect(goalLabel('Book meetings')).toBe('Book meetings')
    expect(goalLabel('something bespoke')).toBe('something bespoke')
    expect(goalLabel(null)).toBeNull()
    expect(goalKey('nurture')).toBe('nurture')
    expect(goalKey('Nurture relationships')).toBe('nurture')
    expect(goalKey('totally custom')).toBeNull()
  })
})

describe('journey recipes (db)', () => {
  let db: TestDb

  beforeEach(async () => {
    db = await createTestDb()
  })
  afterEach(async () => {
    await db.close()
  })

  it('seeds the built-in recipes', async () => {
    const recipes = await listRecipes(db)
    const keys = recipes.map((r) => r.key).sort()
    expect(keys).toEqual(['breakup_last_touch', 'cold_outreach_3step', 'post_meeting_followup', 'reengagement_2step'])
    const cold = await getRecipe(db, 'cold_outreach_3step')
    expect(cold?.goal_key).toBe('book_meetings')
    expect(cold?.steps).toHaveLength(3)
    expect(cold?.steps[0]).toMatchObject({ step_number: 1, variant: 'A', delay_days: 0 })
    expect(await getRecipe(db, 'nope')).toBeNull()
  })

  it('instantiates a recipe into a campaign with its goal and steps', async () => {
    const { campaign, steps, recipe } = await instantiateRecipe(db, ACTOR, { key: 'cold_outreach_3step' })
    expect(recipe.key).toBe('cold_outreach_3step')
    expect(campaign.name).toBe('Cold outreach (3 steps)')
    expect(campaign.goal).toBe('Book meetings')
    expect(steps).toHaveLength(3)
    expect(steps.map((s) => s.step_number)).toEqual([1, 2, 3])
    const stored = await db.query<{ subject: string }>(
      `select subject from lp.campaign_steps where campaign_id = $1 order by step_number`,
      [campaign.id],
    )
    expect(stored.rows).toHaveLength(3)
    expect(stored.rows[0].subject).toContain('Quick question')
  })

  it('honours a custom name and a goal override', async () => {
    const { campaign, steps } = await instantiateRecipe(db, ACTOR, {
      key: 'breakup_last_touch',
      name: 'Q4 breakup',
      goal: 'Get replies',
    })
    expect(campaign.name).toBe('Q4 breakup')
    expect(campaign.goal).toBe('Get replies')
    expect(steps).toHaveLength(1)
  })

  it('rejects unknown recipes', async () => {
    await expect(instantiateRecipe(db, ACTOR, { key: 'nope' })).rejects.toThrow(RecipeError)
  })
})
