/**
 * The rules PR's evaluator, wired into the campaigns workspace (see evaluator.ts):
 * live scoring for the leads on a page, and "own rules" per campaign through
 * createRuleSet (people only; the rules PR's database trigger enforces it).
 */
import type { Db, Queryable } from '../db/types.ts'
import { evaluateCompanies } from '../rules/recompute.ts'
import { createRuleSet, getRuleSet } from '../rules/store.ts'
import type { LiveBackend, RulesWriter, Verdict } from './evaluator.ts'

export const liveBackend: LiveBackend = {
  async score(q: Queryable, ruleSetId: number, companyIds: number[]) {
    const rs = await getRuleSet(q, ruleSetId)
    const out = new Map<number, Verdict>()
    if (!rs) return out
    for (const v of await evaluateCompanies(q, rs, companyIds)) {
      out.set(v.company_id, {
        company_id: v.company_id,
        contact_id: v.contact_id,
        tier: v.tier,
        batch: v.batch,
        reasons: v.reasons,
        merge: v.merge,
        missing: v.missing,
        source: 'live',
        stale: false,
        evaluated_at: new Date(),
      })
    }
    return out
  },
}

export const rulesWriter: RulesWriter = {
  async createOwn(db, actor, input) {
    const made = await createRuleSet(db as Db, actor, { scope: 'campaign', name: input.name, segment: input.pool, from_id: input.fromId })
    return made.id
  },
}
