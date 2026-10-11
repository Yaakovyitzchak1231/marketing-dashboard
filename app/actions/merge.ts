'use server'

/**
 * Duplicate detection & merge (plan 1.9), run as the signed-in human ('owner').
 */
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/db'
import { findCandidates, type MergeCandidate, type MergeEntity } from '@/lib/merge/candidates'
import { MergeError, merge as runMerge, type MergeResult } from '@/lib/merge/merge'

const ME = 'owner'

type Fail = { ok: false; error: string }
const NOT_CONNECTED: Fail = { ok: false, error: 'The database is not connected, so this is not saved.' }

function fail(e: unknown): Fail {
  if (e instanceof MergeError) return { ok: false, error: e.message }
  console.error('merge failed', (e as Error).message)
  return { ok: false, error: "That didn't save. Try again." }
}

export async function mergeCandidatesAction(entity: MergeEntity): Promise<{ ok: true; candidates: MergeCandidate[] } | Fail> {
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    const candidates = await findCandidates(db, entity, 50)
    return { ok: true, candidates }
  } catch (e) {
    return fail(e)
  }
}

export async function mergeAction(input: { entity: MergeEntity; keep: number; merge: number; choices?: Record<string, unknown> }): Promise<{ ok: true; result: MergeResult } | Fail> {
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    const result = await runMerge(db, ME, input)
    revalidatePath('/leads')
    revalidatePath('/leads/duplicates')
    return { ok: true, result }
  } catch (e) {
    return fail(e)
  }
}
