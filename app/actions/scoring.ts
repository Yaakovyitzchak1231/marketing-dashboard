'use server'

/**
 * The /settings/scoring page's buttons. Always acts as 'owner' (the signed-in
 * human; middleware.ts gates server actions behind login).
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { actorFor } from '@/lib/auth/act'
import { AuthError } from '@/lib/auth/roles'
import { ScoringError, recomputeScores, upsertScoreModel } from '@/lib/scoring/engine'
import { getJob, runNow } from '@/lib/jobs/store'

function db() {
  const d = getDb()
  if (!d) throw new Error('The lead database is not connected (DATABASE_URL is not set).')
  return d
}
const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}
const msg = (e: unknown) => (e instanceof AuthError ? e.message : e instanceof ScoringError ? e.message : e instanceof SyntaxError ? 'rules must be valid JSON' : null)

/** A JSON textarea, with an error that names the box that is wrong (not always "rules"). */
function parseJsonField(text: string, label: string): unknown {
  try {
    return JSON.parse(text || '[]')
  } catch {
    throw new ScoringError(`${label} must be valid JSON.`)
  }
}

function back(q: Record<string, string>): never {
  const u = new URLSearchParams(q)
  redirect(`/settings/scoring?${u.toString()}`)
}

export async function saveScoreModelRulesAction(f: FormData) {
  try {
    const ME = await actorFor('owner')
    const id = Number(s(f, 'id'))
    const rulesText = s(f, 'rules_json')
    const thresholdsText = s(f, 'thresholds_json')
    await upsertScoreModel(db(), ME, {
      id,
      name: s(f, 'name'),
      entity: s(f, 'entity') as 'company' | 'contact',
      kind: s(f, 'kind') as 'engagement' | 'fit',
      campaign_id: s(f, 'campaign_id') ? Number(s(f, 'campaign_id')) : null,
      rules: parseJsonField(rulesText, 'Rules'),
      thresholds: parseJsonField(thresholdsText, 'Thresholds'),
      // No max_points field on the form = keep the stored cap; an empty field clears it.
      max_points: f.has('max_points') ? (s(f, 'max_points') ? Number(s(f, 'max_points')) : null) : undefined,
    })
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  revalidatePath('/settings/scoring')
  back({ saved: 'Saved.' })
}

export async function recomputeAllScoresAction() {
  // Review fix (#74): never recompute every lead inside this page request (it timed out
  // around 50k leads and rolled everything back). Queue the background 'score_refresh'
  // job instead; the runner picks it up on its next poll. Only when that job isn't
  // registered on this database does it fall back to running here, in committed batches.
  let queued = false
  try {
    const ME = await actorFor('owner')
    const d = db()
    if (await getJob(d, 'score_refresh')) {
      await runNow(d, ME, 'score_refresh')
      queued = true
    } else {
      await recomputeScores(d, ME, {})
    }
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  revalidatePath('/settings/scoring')
  back({ saved: queued ? 'Queued. The background runner recomputes every lead within a few minutes (see Jobs).' : 'Recomputed.' })
}
