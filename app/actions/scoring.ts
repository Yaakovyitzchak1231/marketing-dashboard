'use server'

/**
 * The /settings/scoring page's buttons. Always acts as 'owner' (the signed-in
 * human; middleware.ts gates server actions behind login).
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { ScoringError, recomputeScores, upsertScoreModel } from '@/lib/scoring/engine'
import { getJob, runNow } from '@/lib/jobs/store'

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
const msg = (e: unknown) => (e instanceof ScoringError ? e.message : e instanceof SyntaxError ? 'rules must be valid JSON' : null)

function back(q: Record<string, string>): never {
  const u = new URLSearchParams(q)
  redirect(`/settings/scoring?${u.toString()}`)
}

export async function saveScoreModelRulesAction(f: FormData) {
  try {
    const id = Number(s(f, 'id'))
    const rulesText = s(f, 'rules_json')
    const thresholdsText = s(f, 'thresholds_json')
    await upsertScoreModel(db(), ME, {
      id,
      name: s(f, 'name'),
      entity: s(f, 'entity') as 'company' | 'contact',
      kind: s(f, 'kind') as 'engagement' | 'fit',
      campaign_id: s(f, 'campaign_id') ? Number(s(f, 'campaign_id')) : null,
      rules: JSON.parse(rulesText || '[]'),
      thresholds: JSON.parse(thresholdsText || '[]'),
      max_points: s(f, 'max_points') ? Number(s(f, 'max_points')) : null,
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
