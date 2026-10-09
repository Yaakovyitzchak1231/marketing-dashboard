/**
 * Lead rules API (humans; behind the login gate, actor = the owner).
 *
 *   GET  /api/rules            -> {rule_sets: [... with counts + re-score status], standing_rules, fields, conditions, proposals}
 *   POST /api/rules            {scope: 'campaign'|'template', from_id, campaign_id?, campaign_name?, segment?, name?}
 *                              -> 201 {rule_set}   (start a campaign's own rules from a template or another set)
 *   GET  /api/rules/:id        -> {rule_set, counts, rescore, proposals, top_reasons}
 *   PUT  /api/rules/:id        {name, requirements: [...], fields: [...], base_version?}
 *                              -> 200 {rule_set, changes}  · 409 if base_version is stale
 *                              Saving logs every change (old -> new) and re-scores that set in the background.
 *   DELETE /api/rules/:id      -> remove a campaign's own rules (back to its pool's) or a template
 *   POST /api/rules/:id/recompute            -> queue a full re-score now
 *   POST /api/rules/proposals/:approvalId    {decision: 'apply'|'reject', note?}  -> apply or reject an agent's proposal
 *
 * Agents read the same data through /api/ops (list_rule_sets, get_rule_set, lead_readiness) and can only
 * PROPOSE a change (propose_rule_change -> Needs your OK). Shapes: lib/rules/schema.ts; docs: docs/lead-rules.md.
 */
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { createRuleSet, listProposals, listRuleSets } from '@/lib/rules/store'
import { recomputeStatus, tierCounts } from '@/lib/rules/recompute'
import { FIELD_CATALOG, OPS } from '@/lib/rules/schema'
import { STANDING_RULES } from '@/lib/rules/standing'
import { kickRecompute } from '@/lib/rules/kick'
import { NO_DB, rulesFail } from '@/lib/rules/http'

export const dynamic = 'force-dynamic'

export async function GET() {
  const db = getDb()
  if (!db) return NextResponse.json({ error: NO_DB }, { status: 503 })
  const [sets, counts, jobs, proposals] = await Promise.all([listRuleSets(db), tierCounts(db), recomputeStatus(db), listProposals(db)])
  return NextResponse.json({
    rule_sets: sets.map((s) => ({ ...s, counts: counts.get(s.id) ?? null, rescore: jobs.get(s.id) ?? null })),
    standing_rules: STANDING_RULES,
    fields: FIELD_CATALOG,
    conditions: OPS,
    proposals,
  })
}

export async function POST(req: Request) {
  const db = getDb()
  if (!db) return NextResponse.json({ error: NO_DB }, { status: 503 })
  try {
    const body = (await req.json().catch(() => null)) ?? {}
    const rs = await createRuleSet(db, 'owner', body as Record<string, unknown>)
    kickRecompute(db)
    return NextResponse.json({ rule_set: rs }, { status: 201 })
  } catch (e) {
    return rulesFail(e)
  }
}
