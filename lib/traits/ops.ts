/**
 * Trait ops for agents and the dashboard (POST /api/ops {op, ...};
 * lib/ops/dispatch.ts spreads these in). Mirrors lib/segments/ops.ts's shape:
 * thin wrappers over lib/traits/store.ts + compute.ts that turn
 * TraitError / TraitDefinitionError into OpsError.
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { TraitDefinitionError, validateTraitDefinition, validateTraitEntity } from './definition.ts'
import { archiveTrait, defineTrait, getTrait, listTraits, TraitError, type Trait } from './store.ts'
import { computeTraitValues, recomputeOneTrait } from './compute.ts'
import { ensureTraitFieldsRegistered } from './register.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof TraitError) throw new OpsError(e.message, e.status)
      if (e instanceof TraitDefinitionError) throw new OpsError(e.message, 400)
      throw e
    }
  }
}

function keyArg(a: Args): string {
  const k = typeof a.key === 'string' ? a.key.trim() : ''
  if (!k) throw new OpsError('key is required')
  return k
}

async function requireTrait(db: Db, key: string): Promise<Trait> {
  const t = await getTrait(db, key)
  if (!t) throw new OpsError(`No trait "${key}".`, 404)
  return t
}

export const TRAIT_OPS: Record<string, Op> = {
  list_traits: {
    args: '{include_archived?}',
    run: (db, _actor, a) => listTraits(db, { includeArchived: a.include_archived === true || a.include_archived === 'true' }),
  },
  get_trait: {
    args: '{key}',
    run: wrap((db, _actor, a) => requireTrait(db, keyArg(a))),
  },
  define_trait: {
    args: '{key, label, entity, definition}  -- upsert by key; redefining resets last_computed_at (full recompute next run)',
    run: wrap(async (db, actor, a) => {
      const trait = await db.tx(
        (q) =>
          defineTrait(q, actor, {
            key: String(a.key ?? ''),
            label: String(a.label ?? ''),
            entity: String(a.entity ?? ''),
            definition: a.definition,
          }),
        actor,
      )
      // Make it usable in a segment condition immediately, not just on the next request
      // that happens to call ensureTraitFieldsRegistered.
      await ensureTraitFieldsRegistered(db)
      return trait
    }),
  },
  archive_trait: {
    args: '{key}',
    run: wrap(async (db, actor, a) => {
      const key = keyArg(a)
      const trait = await db.tx((q) => archiveTrait(q, actor, key), actor)
      await ensureTraitFieldsRegistered(db)
      return trait
    }),
  },
  /** Recompute one trait (key given) or every active trait (key omitted). Incremental
   *  by default (only entities with new events since the last run); full: true forces
   *  a full recompute of every entity -- use after redefining a trait's rules, or to
   *  seed values the first time (define_trait already resets last_computed_at to null,
   *  which this treats as "never run", i.e. full on its own). */
  recompute_traits: {
    args: '{key?, full?}',
    run: wrap(async (db, _actor, a) => {
      const full = a.full === true || a.full === 'true'
      const traits = a.key ? [await requireTrait(db, keyArg(a))] : await listTraits(db, { includeArchived: false })
      const results = []
      for (const t of traits) {
        results.push(await db.tx((q) => recomputeOneTrait(q, t, { full }), 'system'))
      }
      return { traits: traits.length, results }
    }),
  },
  /** Values this (not-necessarily-saved) definition would produce for up to 5 sample
   *  leads of the given entity -- the builder's "preview before you save" panel. Reads
   *  the DB for sample ids but writes nothing to lp.trait_values. */
  trait_preview: {
    args: '{entity, definition, sample_size?}',
    run: wrap(async (db, _actor, a) => {
      const entity = validateTraitEntity(a.entity)
      const definition = validateTraitDefinition(a.definition)
      const sampleSize = Math.min(Math.max(a.sample_size == null ? 5 : Number(a.sample_size), 1), 20)
      const table = entity === 'company' ? 'lp.companies' : 'lp.contacts'
      const nameCol = entity === 'company' ? 'name' : 'email_norm'
      const { rows: sample } = await db.query<{ id: number; label: string }>(`select id, ${nameCol} as label from ${table} order by id limit $1`, [sampleSize])
      const values = await computeTraitValues(db, { entity, definition }, sample.map((r) => Number(r.id)))
      const byId = new Map(values.map((v) => [v.entity_id, v.value]))
      return { entity, sample: sample.map((r) => ({ id: Number(r.id), label: r.label, value: byId.get(Number(r.id)) ?? null })) }
    }),
  },
}
