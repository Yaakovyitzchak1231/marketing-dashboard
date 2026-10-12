/**
 * Journey templates (recipes) — plan 3.16.
 *
 * Pre-built recipes (seeded by migration 0064) selectable at journey
 * creation. Instantiating a recipe creates a campaign with the recipe's
 * goal and its steps, ready to edit. This is separate from the existing
 * user-saved campaign copies (is_template): recipes ship with the product.
 *
 * Deliverability note: the seeded step copy carries no unsubscribe footer.
 * The sending platform (Instantly) appends its own unsubscribe +
 * sender-identification footer at send time, so do not add one to the
 * recipe copy or leads will get two.
 */
import type { Db, Queryable } from '../db/types.ts'
import { createCampaign } from '../campaigns/store.ts'
import { poolExists } from '../pools/store.ts'
import type { Campaign } from '../campaigns/types.ts'
import { createStep, type StepRow } from '../campaign-steps/store.ts'
import { goalLabel } from './goals.ts'

export class RecipeError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'RecipeError'
    this.status = status
  }
}

export interface RecipeStep {
  step_number: number
  variant: string
  subject: string
  body: string
  delay_days: number
}

export interface Recipe {
  id: number
  key: string
  name: string
  description: string
  goal_key: string
  steps: RecipeStep[]
  active: boolean
  sort: number
}

function row(r: Record<string, unknown>): Recipe {
  const steps = (r.steps as unknown[]) ?? []
  return {
    id: Number(r.id),
    key: String(r.key),
    name: String(r.name),
    description: String(r.description),
    goal_key: String(r.goal_key),
    steps: steps.map((s) => {
      const o = s as Record<string, unknown>
      return {
        step_number: Number(o.step_number),
        variant: String(o.variant ?? 'A'),
        subject: String(o.subject ?? ''),
        body: String(o.body ?? ''),
        delay_days: Number(o.delay_days ?? 0),
      }
    }),
    active: Boolean(r.active),
    sort: Number(r.sort),
  }
}

export async function listRecipes(q: Queryable, opts: { activeOnly?: boolean } = {}): Promise<Recipe[]> {
  const r = await q.query<Record<string, unknown>>(
    `select * from lp.journey_recipes ${opts.activeOnly === false ? '' : 'where active'} order by sort, name`,
  )
  return r.rows.map(row)
}

export async function getRecipe(q: Queryable, key: string): Promise<Recipe | null> {
  const r = await q.query<Record<string, unknown>>('select * from lp.journey_recipes where key = $1', [key])
  return r.rows.length ? row(r.rows[0]) : null
}

export interface InstantiateInput {
  key: string
  /** Campaign name; defaults to the recipe name. */
  name?: string | null
  /** Required: which pool the campaign belongs to (no hard-coded default). */
  pool?: string | null
  /** Overrides the recipe's goal (a goal key, label, or custom text). */
  goal?: string | null
}

/**
 * Build a campaign from a recipe: the campaign carries the recipe's goal
 * (unless overridden) and gets one campaign step per recipe step.
 *
 * One transaction for the campaign and all its steps: a failed step rolls
 * everything back, so a retry never creates a second campaign. The inner
 * writers (createCampaign, createStep) each call .tx(); those nested calls
 * are flattened onto this transaction's client (PGlite deadlocks on real
 * nesting).
 */
export async function instantiateRecipe(
  db: Db,
  actor: string,
  input: InstantiateInput,
): Promise<{ campaign: Campaign; steps: StepRow[]; recipe: Recipe }> {
  const recipe = await getRecipe(db, input.key)
  if (!recipe) throw new RecipeError(`No recipe "${input.key}".`, 404)
  if (!recipe.active) throw new RecipeError(`Recipe "${recipe.name}" is not active.`, 400)
  const name = (input.name ?? '').trim() || recipe.name
  if (name.length > 120) throw new RecipeError('Name is too long (max 120 characters).')
  const pool = (input.pool ?? '').trim()
  if (!pool) throw new RecipeError('A pool is required: pick which pool this campaign belongs to.')
  if (!(await poolExists(db, pool))) throw new RecipeError(`Unknown pool "${pool}". Create it first (Pools), or pick an existing one.`)
  const goal = input.goal != null && input.goal !== '' ? input.goal : (goalLabel(recipe.goal_key) ?? recipe.goal_key)
  return db.tx(async (q) => {
    const tx = { tx: <T>(fn: (qq: Queryable) => Promise<T>) => fn(q) }
    const campaign = await createCampaign(
      tx,
      actor,
      { name, pool, goal } as { name: string; pool?: string; goal?: string },
      { via: 'recipe' },
    )
    const dbOnTx = { query: q.query.bind(q), tx: tx.tx } as Db
    const steps: StepRow[] = []
    for (const rs of recipe.steps) {
      steps.push(
        await createStep(dbOnTx, actor, campaign.id, {
          step_number: rs.step_number,
          variant: rs.variant,
          subject: rs.subject,
          body: rs.body,
          delay_days: rs.delay_days,
        }),
      )
    }
    return { campaign, steps, recipe }
  }, actor)
}
