/**
 * The ONE place the campaigns workspace talks to the rules evaluator (PR 1,
 * "per-campaign rule sets + evaluator", migration 0010, lib/rules/*).
 *
 * How a campaign finds its rules (PR 1's contract, EVALUATOR_INTERFACE.md):
 *   1. lp.campaigns.rule_set_id, if that set still exists and is not archived. A
 *      campaign's OWN rules are a scope 'campaign' set made by PR 1's
 *      createRuleSet (no campaign_id) and pointed at here; a template or another
 *      pool's set can be picked too;
 *   2. the pool's rule set (scope 'pool', segment = the campaign's pool);
 *   3. the default rule set.
 *
 * Two ways to get a lead's status:
 *   - live: PR 1's evaluateCompanies() scores the leads on the page right now
 *     (./evaluator-live.ts);
 *   - stored: PR 1's lp.lead_evaluations rows (kept fresh by its background
 *     re-score). Read with plain SQL, so it works the moment 0010 is in the
 *     database, even before the one-line switch.
 * Before 0010 exists at all, every lead shows "not scored yet" (never a guess).
 *
 * Wired to PR 1 in ./evaluator-live.ts (live scoring + own rules per campaign).
 */
import type { Queryable } from '../db/types.ts'
import type { Campaign } from './types.ts'

export type Tier = 'ready_personalized' | 'ready_generic' | 'parked'
export const TIER_WORDS: Record<Tier, string> = {
  ready_personalized: 'Ready, personalized',
  ready_generic: 'Ready, generic',
  parked: 'Parked',
}

export interface Reason {
  rule: string
  label: string
  detail: string
  standing: boolean
}

export interface Verdict {
  company_id: number
  contact_id: number | null
  tier: Tier
  batch: 'standard' | 'role-inbox'
  reasons: Reason[]
  merge: Record<string, string>
  missing: string[]
  /** live = scored just now; stored = PR 1's saved score (stale = the lead changed since). */
  source: 'live' | 'stored'
  stale: boolean
  evaluated_at: Date | null
}

export interface RuleSetRef {
  id: number
  name: string
  scope: string
  version: number
  /** Why this set applies: own (this campaign's own set) / picked (a shared set chosen for it) / pool / default. */
  via: 'own' | 'picked' | 'pool' | 'default'
}

export interface LiveBackend {
  score(q: Queryable, ruleSetId: number, companyIds: number[]): Promise<Map<number, Verdict>>
}

/** Writes rule sets through PR 1's createRuleSet (humans only; PR 1's database trigger enforces it). */
export interface RulesWriter {
  /** A new scope 'campaign' set copied from `fromId` (or the pool's rules); returns its id. */
  createOwn(db: { tx<T>(fn: (q: Queryable) => Promise<T>, actor?: string): Promise<T> }, actor: string, input: { name: string; pool: string; fromId: number | null }): Promise<number>
}

import { liveBackend, rulesWriter } from './evaluator-live.ts'
export { rulesWriter }

async function rulesTablesExist(q: Queryable): Promise<boolean> {
  const { rows } = await q.query<{ a: string | null; b: string | null }>(
    `select to_regclass('lp.rule_sets')::text as a, to_regclass('lp.lead_evaluations')::text as b`,
  )
  return Boolean(rows[0]?.a && rows[0]?.b)
}

/** Which rule set this campaign uses, or null when the rules tables are not there yet. */
export async function ruleSetFor(q: Queryable, c: Pick<Campaign, 'id' | 'pool' | 'rule_set_id'>): Promise<RuleSetRef | null> {
  if (!(await rulesTablesExist(q))) return null
  const { rows } = await q.query<{ id: number; name: string; scope: string; version: number; via: RuleSetRef['via'] }>(
    `select id, name, scope, version, via from (
        select r.id, r.name, r.scope, r.version, case when r.scope = 'campaign' then 'own' else 'picked' end as via, 1 as rank
          from lp.rule_sets r where r.id = $1 and not coalesce(r.archived, false)
        union all
        select r.id, r.name, r.scope, r.version, 'pool', 2 from lp.rule_sets r where r.scope = 'pool' and r.segment = $2 and not coalesce(r.archived, false)
        union all
        select r.id, r.name, r.scope, r.version, 'default', 3 from lp.rule_sets r where r.scope = 'default'
      ) x order by rank, id limit 1`,
    [c.rule_set_id ?? null, c.pool],
  )
  const r = rows[0]
  return r ? { id: Number(r.id), name: r.name, scope: r.scope, version: Number(r.version), via: r.via } : null
}

/**
 * Rule sets a campaign can point at (the settings form): the default, the pools,
 * templates, and this campaign's own set. Other campaigns' own sets are not
 * offered: copy one (Duplicate) instead of sharing it. Empty before PR 1.
 */
export async function pickableRuleSets(q: Queryable, current: number | null = null): Promise<{ id: number; name: string; scope: string; segment: string | null }[]> {
  if (!(await rulesTablesExist(q))) return []
  const { rows } = await q.query<{ id: number; name: string; scope: string; segment: string | null }>(
    `select id, name, scope, segment from lp.rule_sets
      where not coalesce(archived, false) and (scope <> 'campaign' or id = $1)
      order by case scope when 'default' then 0 when 'pool' then 1 when 'template' then 2 else 3 end, name, id`,
    [current],
  )
  return rows.map((r) => ({ ...r, id: Number(r.id) }))
}

/** The scope of a rule set, or null (missing table or id). */
export async function ruleSetScope(q: Queryable, id: number | null): Promise<string | null> {
  if (id == null || !(await rulesTablesExist(q))) return null
  const { rows } = await q.query<{ scope: string }>('select scope from lp.rule_sets where id = $1', [id])
  return rows[0]?.scope ?? null
}

async function stored(q: Queryable, ruleSetId: number, companyIds: number[]): Promise<Map<number, Verdict>> {
  const { rows } = await q.query<{
    company_id: number; contact_id: number | null; tier: Tier; batch: Verdict['batch']; reasons: Reason[]
    merge: Record<string, string>; missing: string[]; stale: boolean; evaluated_at: Date
  }>(
    `select company_id, contact_id, tier, batch, reasons, merge, missing, stale, evaluated_at
       from lp.lead_evaluations where rule_set_id = $1 and company_id = any($2::bigint[])`,
    [ruleSetId, companyIds],
  )
  return new Map(
    rows.map((r) => [
      Number(r.company_id),
      {
        company_id: Number(r.company_id),
        contact_id: r.contact_id == null ? null : Number(r.contact_id),
        tier: r.tier,
        batch: r.batch ?? 'standard',
        reasons: Array.isArray(r.reasons) ? r.reasons : [],
        merge: r.merge && typeof r.merge === 'object' ? r.merge : {},
        missing: Array.isArray(r.missing) ? r.missing : [],
        source: 'stored' as const,
        stale: Boolean(r.stale),
        evaluated_at: r.evaluated_at ?? null,
      },
    ]),
  )
}

/**
 * Status for these leads under the campaign's rules. Leads with no score come
 * back missing from the map (the UI says "not scored yet").
 */
export async function verdictsFor(
  q: Queryable,
  c: Pick<Campaign, 'id' | 'pool' | 'rule_set_id'>,
  companyIds: number[],
  backend: LiveBackend | null = liveBackend,
): Promise<{ ruleSet: RuleSetRef | null; verdicts: Map<number, Verdict> }> {
  const ruleSet = await ruleSetFor(q, c)
  if (!ruleSet || !companyIds.length) return { ruleSet, verdicts: new Map() }
  if (backend) {
    try {
      return { ruleSet, verdicts: await backend.score(q, ruleSet.id, companyIds) }
    } catch (e) {
      console.error('live scoring failed; showing stored scores', (e as Error).message)
    }
  }
  return { ruleSet, verdicts: await stored(q, ruleSet.id, companyIds) }
}

/** Tier counts for a whole campaign from stored scores (null before PR 1). */
export async function tierCountsFor(
  q: Queryable,
  c: Pick<Campaign, 'id' | 'pool' | 'rule_set_id'>,
): Promise<{ ruleSet: RuleSetRef; ready_personalized: number; ready_generic: number; parked: number; not_scored: number } | null> {
  const ruleSet = await ruleSetFor(q, c)
  if (!ruleSet) return null
  const { rows } = await q.query<{ tier: string | null; n: number }>(
    `select e.tier, count(*)::int as n from lp.campaign_leads l
       left join lp.lead_evaluations e on e.rule_set_id = $2 and e.company_id = l.company_id
      where l.campaign_id = $1 group by e.tier`,
    [c.id, ruleSet.id],
  )
  const out = { ruleSet, ready_personalized: 0, ready_generic: 0, parked: 0, not_scored: 0 }
  for (const r of rows) {
    const n = Number(r.n)
    if (r.tier === 'ready_personalized' || r.tier === 'ready_generic' || r.tier === 'parked') out[r.tier] += n
    else out.not_scored += n
  }
  return out
}
