/** Ready / Parked, as the Overview and the lead page show it. Same evaluator everywhere. */
import type { Queryable } from '../db/types.ts'
import { evaluateLead, type LeadVerdict } from './evaluate.ts'
import { loadLeadFacts } from './load.ts'
import { ruleSetsForSegment, type RuleSetRow } from './store.ts'
import { topParkReasons } from './recompute.ts'

export interface OverviewReadiness {
  personalized: number
  generic: number
  parked: number
  /** Leads with a stored verdict under their pool's rules, and all leads. */
  scored: number
  companies: number
  stale: number
  rescoring: boolean
  topReasons: { rule: string; label: string; n: number }[]
}

/** Every lead counted once, under its pool's rules. */
export async function overviewReadiness(q: Queryable): Promise<OverviewReadiness | null> {
  try {
    const [t, jobs, reasons] = await Promise.all([
      q.query<{ tier: string; n: number; stale: number }>(
        `select e.tier, count(*)::int as n, count(*) filter (where e.stale)::int as stale
           from lp.lead_evaluations e join lp.rule_sets s on s.id = e.rule_set_id and s.scope = 'pool' and not s.archived
          group by e.tier`,
      ),
      q.query<{ n: number; companies: number }>(
        `select (select count(*)::int from lp.rule_recompute where status in ('queued', 'running')) as n,
                (select count(*)::int from lp.companies) as companies`,
      ),
      topParkReasons(q, null, 5),
    ])
    const by = (k: string) => Number(t.rows.find((r) => r.tier === k)?.n ?? 0)
    return {
      personalized: by('ready_personalized'),
      generic: by('ready_generic'),
      parked: by('parked'),
      scored: t.rows.reduce((s, r) => s + Number(r.n), 0),
      companies: Number(jobs.rows[0].companies),
      stale: t.rows.reduce((s, r) => s + Number(r.stale), 0),
      rescoring: Number(jobs.rows[0].n) > 0,
      topReasons: reasons,
    }
  } catch (e) {
    // Before migration 0010 the tables don't exist: say "not available", don't invent.
    if (/lead_evaluations|rule_sets|rule_recompute/.test((e as Error).message)) return null
    throw e
  }
}

export interface LeadReadiness {
  ruleSet: RuleSetRow
  verdict: LeadVerdict
}

/** Live verdicts for one lead under every rule set that scores its pool. */
export async function leadReadiness(q: Queryable, companyId: number, now = new Date()): Promise<LeadReadiness[]> {
  const facts = (await loadLeadFacts(q, [companyId])).get(companyId)
  if (!facts) return []
  let sets: RuleSetRow[]
  try {
    sets = await ruleSetsForSegment(q, facts.company.segment)
  } catch (e) {
    if (/rule_sets/.test((e as Error).message)) return []
    throw e
  }
  return sets.map((rs) => ({ ruleSet: rs, verdict: evaluateLead(facts, rs, now) }))
}
