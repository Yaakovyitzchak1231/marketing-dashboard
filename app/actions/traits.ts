'use server'

/**
 * Traits screen, from the dashboard (the signed-in human, 'owner'). Same
 * functions agents reach through /api/ops (lib/traits/ops.ts). A bad input
 * comes back to the page as ?error=... instead of an error screen, same
 * convention as app/actions/jobs.ts.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { OpsError } from '@/lib/ops/core'
import { defineTrait, archiveTrait } from '@/lib/traits/store'
import { ensureTraitFieldsRegistered } from '@/lib/traits/register'
import { validateTraitDefinition } from '@/lib/traits/definition'
import { computeTraitValues } from '@/lib/traits/compute'

const ME = 'owner'

function db() {
  const d = getDb()
  if (!d) throw new Error('The lead database is not connected (DATABASE_URL is not set).')
  return d
}

const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}

function definitionFromForm(f: FormData): Record<string, unknown> {
  const eventTypes = s(f, 'event_types')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const propFilters = []
  const filterPath = s(f, 'filter_path')
  if (filterPath) {
    propFilters.push({ path: filterPath, op: s(f, 'filter_op') || 'is', value: s(f, 'filter_value') })
  }
  return {
    event_types: eventTypes,
    aggregation: s(f, 'aggregation') || 'count',
    prop: s(f, 'prop') || null,
    window_days: s(f, 'window_days') ? Number(s(f, 'window_days')) : null,
    prop_filters: propFilters,
  }
}

async function guarded(path: string, fn: () => Promise<void>) {
  try {
    await fn()
  } catch (e) {
    if (e instanceof OpsError) redirect(`${path}?error=${encodeURIComponent(e.message)}`)
    throw e
  }
  revalidatePath(path)
  redirect(path)
}

export async function defineTraitAction(f: FormData) {
  await guarded('/segments/traits', async () => {
    const d = db()
    await defineTrait(d, ME, { key: s(f, 'key'), label: s(f, 'label'), entity: s(f, 'entity') || 'company', definition: definitionFromForm(f) }, 'ui')
    await ensureTraitFieldsRegistered(d)
  })
}

export async function archiveTraitAction(f: FormData) {
  await guarded('/segments/traits', async () => {
    const d = db()
    await archiveTrait(d, ME, s(f, 'key'), 'ui')
    await ensureTraitFieldsRegistered(d)
  })
}

/** Preview is a GET-style redirect (like the rest of this screen): no definition is
 *  saved, so the result rides the URL as ?preview=<base64 json> and the page itself
 *  computes + renders it. Keeps this screen server-rendered with no client JS, same
 *  as app/jobs. */
export async function previewTraitAction(f: FormData) {
  const def = definitionFromForm(f)
  const entity = s(f, 'entity') || 'company'
  try {
    validateTraitDefinition(def)
  } catch (e) {
    redirect(`/segments/traits?error=${encodeURIComponent((e as Error).message)}`)
  }
  const encoded = Buffer.from(JSON.stringify({ entity, def })).toString('base64url')
  redirect(`/segments/traits?preview=${encoded}`)
}

export interface TraitPreviewResult {
  entity: string
  sample: { id: number; label: string; value: number | null }[]
}

export async function computePreviewFromQuery(encoded: string): Promise<TraitPreviewResult | null> {
  let parsed: { entity: 'company' | 'contact'; def: unknown }
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const d = db()
  const definition = validateTraitDefinition(parsed.def)
  const table = parsed.entity === 'company' ? 'lp.companies' : 'lp.contacts'
  const nameCol = parsed.entity === 'company' ? 'name' : 'email_norm'
  const { rows: sample } = await d.query<{ id: number; label: string }>(`select id, ${nameCol} as label from ${table} order by id limit 5`)
  const values = await computeTraitValues(d, { entity: parsed.entity, definition }, sample.map((r) => Number(r.id)))
  const byId = new Map(values.map((v) => [v.entity_id, v.value]))
  return { entity: parsed.entity, sample: sample.map((r) => ({ id: Number(r.id), label: r.label, value: byId.get(Number(r.id)) ?? null })) }
}
