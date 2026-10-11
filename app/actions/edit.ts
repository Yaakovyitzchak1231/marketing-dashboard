'use server'

/**
 * The universal inline-edit server action (plan item 1.3): every InlineEditCell
 * and the History drawer call these. Runs as the signed-in person (editor or owner, by their own actor id),
 * via 'ui' — the same functions an agent reaches through update_entity /
 * entity_history (lib/edit/ops.ts).
 */
import { actorFor } from '@/lib/auth/act'
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/db'
import { updateEntity, updateEntityFields, RegistryError, LeadEditError } from '@/lib/edit/update'
import { FieldError } from '@/lib/fields/store'
import { entityHistory, type HistoryRow } from '@/lib/edit/history'

type Fail = { ok: false; error: string }
const NOT_CONNECTED: Fail = { ok: false, error: 'The database is not connected, so this is not saved.' }

function fail(e: unknown): Fail {
  if (e instanceof RegistryError || e instanceof LeadEditError || e instanceof FieldError) return { ok: false, error: e.message }
  console.error('inline edit failed', (e as Error).message)
  return { ok: false, error: 'That didn\'t save. Try again.' }
}

export interface UpdateEntityActionResult {
  ok: true
  changed: boolean
  field: string
  from: string | null
  to: string | null
}

/** Save one field. Revalidates /leads and /campaigns so lists and pills pick up the change. */
export async function updateEntityAction(input: {
  type: string
  id: string | number
  field: string
  value: unknown
  note?: string
}): Promise<UpdateEntityActionResult | Fail> {
  const who = await actorFor('editor').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (who instanceof Error) return { ok: false, error: who.message }
  const ME = who
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    const r = await updateEntity(db, ME, { ...input, via: 'ui' })
    revalidatePath('/leads')
    revalidatePath('/campaigns')
    return { ok: true, ...r }
  } catch (e) {
    return fail(e)
  }
}

export async function updateEntityFieldsAction(input: {
  type: string
  id: string | number
  fields: Record<string, unknown>
  note?: string
}): Promise<{ ok: true; results: UpdateEntityActionResult[] } | Fail> {
  const who = await actorFor('editor').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (who instanceof Error) return { ok: false, error: who.message }
  const ME = who
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    const results = await updateEntityFields(db, ME, { ...input, via: 'ui' })
    revalidatePath('/leads')
    revalidatePath('/campaigns')
    return { ok: true, results: results.map((r) => ({ ok: true as const, ...r })) }
  } catch (e) {
    return fail(e)
  }
}

export async function entityHistoryAction(input: {
  type: string
  id: string | number
  limit?: number
  before?: number
}): Promise<{ ok: true; rows: HistoryRow[] } | Fail> {
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    const rows = await entityHistory(db, input.type, input.id, { limit: input.limit, before: input.before })
    return { ok: true, rows }
  } catch (e) {
    return fail(e)
  }
}
