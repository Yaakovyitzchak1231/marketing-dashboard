'use server'

/**
 * The Rules page's buttons. Only the signed-in human reaches these (the login
 * gate in middleware.ts protects server actions); the database itself refuses a
 * rule change not made by a human (0010). Every change is logged old -> new and
 * re-scores that rule set in the background.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { applyProposal, archiveRuleSet, createRuleSet, getRuleSet, rejectProposal, saveRuleSet } from '@/lib/rules/store'
import { queueRecompute } from '@/lib/rules/recompute'
import { kickRecompute } from '@/lib/rules/kick'
import { ruleDocFromForm } from '@/lib/rules/form'
import { RulesError } from '@/lib/rules/schema'
import { OpsError } from '@/lib/ops/core'

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
const msg = (e: unknown) => (e instanceof RulesError || e instanceof OpsError ? e.message : null)

function back(path: string, q: Record<string, string>): never {
  const u = new URLSearchParams(q)
  redirect(`${path}?${u.toString()}`)
}

export async function saveRulesAction(f: FormData) {
  const id = Number(s(f, 'rule_set_id'))
  const path = `/rules/${id}`
  const { doc, intent } = ruleDocFromForm((k) => s(f, k))
  let note = 'Saved.'
  try {
    const d = db()
    const out = await saveRuleSet(d, ME, id, doc, { base_version: Number(s(f, 'base_version')) || null })
    note = out.changes.length ? `Saved: ${out.changes.length} change${out.changes.length === 1 ? '' : 's'}. Re-scoring leads in the background.` : 'Nothing changed.'
    if (out.changes.length) kickRecompute(d)
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back(path, { error: m })
  }
  revalidatePath(path)
  revalidatePath('/rules')
  back(path, { saved: intent === 'save' ? note : 'Saved.' })
}

export async function createRulesAction(f: FormData) {
  let id = 0
  try {
    const d = db()
    const rs = await createRuleSet(d, ME, {
      scope: s(f, 'scope'),
      from_id: s(f, 'from_id'),
      campaign_id: s(f, 'campaign_id'),
      campaign_name: s(f, 'campaign_name') || null,
      segment: s(f, 'segment') || null,
      name: s(f, 'name') || null,
    })
    id = rs.id
    kickRecompute(d)
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back('/rules', { error: m })
  }
  revalidatePath('/rules')
  redirect(`/rules/${id}`)
}

export async function archiveRulesAction(f: FormData) {
  const id = Number(s(f, 'rule_set_id'))
  if (s(f, 'confirm') !== 'yes') back(`/rules/${id}`, { error: 'Tick the box to confirm removing these rules.' })
  try {
    await archiveRuleSet(db(), ME, id)
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back(`/rules/${id}`, { error: m })
  }
  revalidatePath('/rules')
  back('/rules', { saved: 'Removed.' })
}

export async function recomputeRulesAction(f: FormData) {
  const id = Number(s(f, 'rule_set_id'))
  const d = db()
  const rs = await getRuleSet(d, id)
  if (rs && !rs.archived && rs.scope !== 'template') {
    await queueRecompute(d, rs.id, rs.version, ME)
    kickRecompute(d)
  }
  revalidatePath(`/rules/${id}`)
  back(`/rules/${id}`, { saved: 'Re-scoring every lead for these rules in the background.' })
}

export async function decideProposalAction(f: FormData) {
  const approval = Number(s(f, 'approval_id'))
  const id = Number(s(f, 'rule_set_id'))
  const decision = s(f, 'decision')
  try {
    const d = db()
    if (decision === 'apply') {
      await applyProposal(d, ME, approval)
      kickRecompute(d)
    } else await rejectProposal(d, ME, approval, s(f, 'note') || null)
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back(`/rules/${id}`, { error: m })
  }
  revalidatePath(`/rules/${id}`)
  revalidatePath('/activity')
  back(`/rules/${id}`, { saved: decision === 'apply' ? 'Proposal applied.' : 'Proposal rejected.' })
}
