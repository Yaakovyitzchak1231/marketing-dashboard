/**
 * The one file that reads what other in-flight PRs own, so merging them is a
 * one-file change here:
 *   - lp.campaigns / lp.campaign_leads  -> worker B's migration 0011 (campaigns workspace)
 *   - personalization field definitions -> worker A's migration 0010 (lp.rule_sets.fields)
 *
 * Until those land, it reads whatever is there and falls back to sensible
 * defaults (0012 itself creates a minimal lp.campaigns / lp.campaign_leads so the
 * steps work on their own). Every read checks the table/column exists first.
 *
 * Lead rules (0010, PR #48) are merged into this branch: fields and verdicts come from
 * effectiveRuleSet / evaluateCompanies (lib/rules).
 * TODO(after 0011 merges): if B names the per-lead overrides differently
 *   (e.g. a separate key/value table), change loadCampaignLeads() only.
 */
import type { Queryable } from '../db/types.ts'
import type { PersonalizationField } from '../rules/schema.ts'
import { effectiveRuleSet } from '../rules/store.ts'
import { evaluateCompanies } from '../rules/recompute.ts'
import type { LeadVerdict } from '../rules/evaluate.ts'

export interface CampaignRef {
  id: number
  name: string
  segment: string | null
  rule_set_id: number | null
  instantly_campaign_id: string | null
  instantly_linked_at: Date | string | null
  instantly_linked_by: string | null
}

export type { PersonalizationField }

export interface CampaignLead {
  company_id: number
  contact_id: number | null
  company_name: string
  email: string | null
  overrides: Record<string, string>
}

/** Used when no rule set (0010) exists yet: the same three fields 0010 seeds, plus city/state. */
export const DEFAULT_FIELDS: PersonalizationField[] = [
  { id: 'f-first-name', name: 'firstName', source: 'contact.first_name', required: false, fallback: 'there', min_confidence: null, enabled: true },
  { id: 'f-company', name: 'companyName', source: 'company.name', required: false, fallback: null, enabled: true },
  { id: 'f-opener', name: 'personalization', source: 'contact.personalization', required: true, fallback: null, enabled: true },
  { id: 'f-city', name: 'city', source: 'company.city', required: false, fallback: null, enabled: true },
  { id: 'f-state', name: 'state', source: 'company.state', required: false, fallback: null, enabled: true },
]

const cache = new WeakMap<object, Map<string, Set<string>>>()

/** Column names of an lp table ('' set when the table does not exist). */
export async function columnsOf(q: Queryable, table: string): Promise<Set<string>> {
  let m = cache.get(q)
  if (!m) cache.set(q, (m = new Map()))
  const hit = m.get(table)
  if (hit) return hit
  const { rows } = await q.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_schema = 'lp' and table_name = $1`,
    [table],
  )
  const s = new Set(rows.map((r) => r.column_name))
  m.set(table, s)
  return s
}

export async function getCampaign(q: Queryable, id: number): Promise<CampaignRef | null> {
  const cols = await columnsOf(q, 'campaigns')
  if (!cols.size) return null
  const pick = (c: string, alias = c) => (cols.has(c) ? `c.${c} as ${alias}` : `null as ${alias}`)
  const segment = cols.has('segment') ? 'c.segment' : cols.has('pool') ? 'c.pool' : 'null'
  const { rows } = await q.query<CampaignRef>(
    `select c.id, c.name, ${segment} as segment, ${pick('rule_set_id')}, ${pick('instantly_campaign_id')},
            ${pick('instantly_linked_at')}, ${pick('instantly_linked_by')}
       from lp.campaigns c where c.id = $1`,
    [id],
  )
  const r = rows[0]
  return r ? { ...r, id: Number(r.id), rule_set_id: r.rule_set_id == null ? null : Number(r.rule_set_id) } : null
}

function normalizeOverrides(v: unknown): Record<string, string> {
  const raw = typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return {} } })() : v
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
      if (val != null && String(val).trim() !== '') out[k] = String(val)
    }
  }
  return out
}

/** The campaign's lead list with each lead's overrides. */
export async function loadCampaignLeads(q: Queryable, campaignId: number, opts: { companyId?: number; limit?: number } = {}): Promise<CampaignLead[]> {
  const cols = await columnsOf(q, 'campaign_leads')
  if (!cols.size) return []
  const overrides = cols.has('overrides') ? 'cl.overrides' : cols.has('personalization_overrides') ? 'cl.personalization_overrides' : `'{}'::jsonb`
  const contact = cols.has('contact_id') ? 'cl.contact_id' : 'null::bigint'
  const { rows } = await q.query<{ company_id: number; contact_id: number | null; company_name: string; email: string | null; overrides: unknown }>(
    `select cl.company_id, ${contact} as contact_id, co.name as company_name, ct.email, ${overrides} as overrides
       from lp.campaign_leads cl
       join lp.companies co on co.id = cl.company_id
       left join lp.contacts ct on ct.id = ${contact}
      where cl.campaign_id = $1 and ($2::bigint is null or cl.company_id = $2)
      order by co.name, cl.company_id
      limit $3`,
    [campaignId, opts.companyId ?? null, Math.min(opts.limit ?? 500, 2000)],
  )
  return rows.map((r) => ({
    company_id: Number(r.company_id),
    contact_id: r.contact_id == null ? null : Number(r.contact_id),
    company_name: r.company_name,
    email: r.email,
    overrides: normalizeOverrides(r.overrides),
  }))
}

export type LiveVerdict = Pick<LeadVerdict, 'tier' | 'batch' | 'reasons' | 'missing' | 'contact_id'>

/**
 * The rules evaluator's verdict for this lead, scored live against the campaign's rule set
 * (same evaluator as the overview, the lead page and the Instantly upload).
 */
export async function liveVerdict(q: Queryable, c: CampaignRef, companyId: number, now = new Date()): Promise<LiveVerdict | null> {
  const rs = await campaignRuleSet(q, c)
  if (!rs) return null
  const [v] = await evaluateCompanies(q, rs, [companyId], now)
  return v ? { tier: v.tier, batch: v.batch, reasons: v.reasons, missing: v.missing, contact_id: v.contact_id } : null
}

/** The campaign's rule set: its own (campaigns.rule_set_id) > its pool's > the default. Null before 0010 is migrated. */
export async function campaignRuleSet(q: Queryable, c: CampaignRef) {
  if (!(await columnsOf(q, 'rule_sets')).size) return null
  try {
    return await effectiveRuleSet(q, { ruleSetId: c.rule_set_id, segment: c.segment })
  } catch {
    return null
  }
}

/** The personalization fields this campaign uses (from its rule set); DEFAULT_FIELDS when there is none. */
export async function fieldsForCampaign(q: Queryable, c: CampaignRef): Promise<{ fields: PersonalizationField[]; from: string; rule_set_id: number | null }> {
  const rs = await campaignRuleSet(q, c)
  if (rs) {
    return { fields: rs.fields.filter((f) => f && f.enabled !== false && f.name && f.source), from: `rules: ${rs.name}`, rule_set_id: rs.id }
  }
  return { fields: DEFAULT_FIELDS, from: 'default fields (lead rules not set up yet)', rule_set_id: null }
}
