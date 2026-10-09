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
 * TODO(after 0010 merges): import PersonalizationField from '@/lib/rules/schema' and
 *   ruleSetForCampaign from '@/lib/rules/store' instead of the local copies below.
 * TODO(after 0011 merges): if B names the per-lead overrides differently
 *   (e.g. a separate key/value table), change loadCampaignLeads() only.
 */
import type { Queryable } from '../db/types.ts'

export interface CampaignRef {
  id: number
  name: string
  segment: string | null
  rule_set_id: number | null
  instantly_campaign_id: string | null
  instantly_linked_at: Date | string | null
  instantly_linked_by: string | null
}

/** Same shape as worker A's PersonalizationField (lib/rules/schema.ts, 0010). */
export interface PersonalizationField {
  id: string
  /** The merge key: {{name}} in a step. */
  name: string
  /** contact.<column>, company.<column>, or enrichment:<fact key>. */
  source: string
  /** Needed for Ready-personalized: without a real value the lead is Ready-generic. */
  required: boolean
  /** Sent when there is no real value. Never counts as a real value. */
  fallback?: string | null
  min_confidence?: 'high' | 'medium' | 'low' | null
  max_age_days?: number | null
  enabled: boolean
}

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

/** Worker A's key for a workspace campaign's own rule set (EVALUATOR_INTERFACE.md). */
export const campaignRuleKey = (id: number) => `c:${id}`

export interface StoredVerdict {
  tier: 'ready_personalized' | 'ready_generic' | 'parked'
  batch: string
  reasons: { rule: string; label: string; detail: string; standing: boolean }[]
  missing: string[]
  stale: boolean
}

/**
 * The evaluator's stored verdict for this lead under that rule set (worker A's
 * lp.lead_evaluations, 0010), or null when 0010 isn't there or the lead isn't scored yet.
 * TODO(after 0010 merges): call evaluateCompanies(q, ruleSet, [companyId]) from
 * '@/lib/rules/recompute' for a live verdict instead of the stored one.
 */
export async function storedVerdict(q: Queryable, ruleSetId: number | null, companyId: number): Promise<StoredVerdict | null> {
  if (ruleSetId == null) return null
  const cols = await columnsOf(q, 'lead_evaluations')
  if (!cols.size) return null
  const { rows } = await q.query<StoredVerdict>(
    `select tier, batch, reasons, missing, stale from lp.lead_evaluations where rule_set_id = $1 and company_id = $2`,
    [ruleSetId, companyId],
  )
  const r = rows[0]
  if (!r) return null
  const arr = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : Array.isArray(v) ? v : [])
  return { ...r, reasons: arr(r.reasons), missing: arr(r.missing) }
}

/**
 * The personalization fields this campaign uses: its own rule set, else its pool's,
 * else the default (worker A's 0010). Without 0010, DEFAULT_FIELDS.
 */
export async function fieldsForCampaign(q: Queryable, c: CampaignRef): Promise<{ fields: PersonalizationField[]; from: string; rule_set_id: number | null }> {
  const rs = await columnsOf(q, 'rule_sets')
  if (rs.size && rs.has('fields')) {
    const { rows } = await q.query<{ id: number; name: string; fields: unknown }>(
      `select id, name, fields from lp.rule_sets r
        where not r.archived and (
              (r.scope = 'campaign' and r.campaign_id = $3)
           or ($1::bigint is not null and r.id = $1)
           or (r.scope = 'pool' and r.segment = $2)
           or r.scope = 'default')
        order by case when r.scope = 'campaign' and r.campaign_id = $3 then 0 when r.id = $1 then 1 when r.scope = 'pool' then 2 else 3 end
        limit 1`,
      [c.rule_set_id, c.segment, campaignRuleKey(c.id)],
    )
    if (rows[0]) {
      const raw = typeof rows[0].fields === 'string' ? JSON.parse(rows[0].fields) : rows[0].fields
      const fields = (Array.isArray(raw) ? raw : []) as PersonalizationField[]
      return {
        fields: fields.filter((f) => f && f.enabled !== false && f.name && f.source),
        from: `rules: ${rows[0].name}`,
        rule_set_id: Number(rows[0].id),
      }
    }
  }
  return { fields: DEFAULT_FIELDS, from: 'default fields (lead rules not set up yet)', rule_set_id: null }
}
