'use server'
/**
 * The retention sweep's two steps (Yaakov, Oct 11): the owner sees exactly what will be
 * deleted, chooses whether old timeline history goes too (off by default; the preview names
 * the score models, traits and segments that read those events), and confirms. Nothing is
 * deleted without that confirmation. Owner only.
 */
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/db'
import { currentActorId, currentRole } from '@/lib/auth/session'
import { AuthError, requireRole } from '@/lib/auth/roles'
import { RetentionError, retentionPreview, retentionSweep, type RetentionPreview } from '@/lib/retention/store'

type Fail = { ok: false; error: string }
const NOT_CONNECTED: Fail = { ok: false, error: 'The database is not connected, so nothing was deleted.' }

function fail(e: unknown): Fail {
  if (e instanceof RetentionError || e instanceof AuthError) return { ok: false, error: e.message }
  console.error('retention sweep failed', (e as Error).message)
  return { ok: false, error: "That didn't run. Nothing was deleted. Try again." }
}

export async function previewRetentionSweepAction(): Promise<({ ok: true } & RetentionPreview) | Fail> {
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    requireRole(await currentRole(), 'owner')
    return { ok: true, ...(await retentionPreview(db)) }
  } catch (e) {
    return fail(e)
  }
}

export async function confirmRetentionSweepAction(input: { includeTimeline: boolean }): Promise<{ ok: true; total_deleted: number; total_timeline_deleted: number; recompute_queued: string[] } | Fail> {
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    requireRole(await currentRole(), 'owner')
    const actor = await currentActorId()
    const r = await retentionSweep(db, actor, { confirm: true, include_timeline: input.includeTimeline === true })
    revalidatePath('/settings')
    return { ok: true, total_deleted: r.total_deleted, total_timeline_deleted: r.total_timeline_deleted, recompute_queued: r.recompute_queued }
  } catch (e) {
    return fail(e)
  }
}
