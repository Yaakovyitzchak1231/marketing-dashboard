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
import { updateEntity, RegistryError, LeadEditError } from '@/lib/edit/update'
import { FieldError } from '@/lib/fields/store'
import { entityHistory, type HistoryRow } from '@/lib/edit/history'
import { requestValueChange } from '@/lib/edit/ask-change'

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

/**
 * "Ask to change" an Instantly-backed number (Engagement tab). Never edits the
 * count: files a pending approval on Activity with the stored current value,
 * the proposed value and the reason (lib/edit/ask-change.ts).
 */
export async function askToChangeAction(input: {
  companyId: number
  campaignId: number
  field: string
  proposed: string
  reason: string
}): Promise<{ ok: true; approvalId: number; current: number } | Fail> {
  const who = await actorFor('editor').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (who instanceof Error) return { ok: false, error: who.message }
  const ME = who
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    const r = await requestValueChange(db, ME, input)
    revalidatePath('/activity')
    return { ok: true, approvalId: r.approval.id, current: r.payload.current }
  } catch (e) {
    return fail(e)
  }
}
