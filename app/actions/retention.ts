'use server'

/**
 * Data retention & delete-a-person (plan 1.12), run as the signed-in human ('owner').
 */
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/db'
import { forgetContact, RetentionError, setRetentionPolicy, type RetentionPolicyRow } from '@/lib/retention/store'

const ME = 'owner'

type Fail = { ok: false; error: string }
const NOT_CONNECTED: Fail = { ok: false, error: 'The database is not connected, so this is not saved.' }

function fail(e: unknown): Fail {
  if (e instanceof RetentionError) return { ok: false, error: e.message }
  console.error('retention action failed', (e as Error).message)
  return { ok: false, error: "That didn't save. Try again." }
}

export async function setRetentionPolicyAction(input: { event_category: string; keep_days: number | null }): Promise<{ ok: true; row: RetentionPolicyRow } | Fail> {
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    const row = await setRetentionPolicy(db, ME, input)
    revalidatePath('/settings')
    return { ok: true, row }
  } catch (e) {
    return fail(e)
  }
}

export async function forgetContactAction(input: { contact_id: number; confirm: string }): Promise<{ ok: true; suppressed: boolean } | Fail> {
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    const result = await forgetContact(db, ME, input)
    revalidatePath('/leads')
    return { ok: true, suppressed: result.suppressed }
  } catch (e) {
    return fail(e)
  }
}
