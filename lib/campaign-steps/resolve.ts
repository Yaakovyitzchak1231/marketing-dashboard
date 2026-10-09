/**
 * Personalization values for one lead in one campaign. Order, first that has a value wins:
 *   1. the campaign-lead override (set on the campaign's lead list)
 *   2. the lead's own field (contact.* / company.*)
 *   3. an enrichment fact (best confidence, then most recently checked)
 *   4. the field's fallback text (counts as "no real value": the lead is Ready-generic)
 */
import type { Queryable } from '../db/types.ts'
import { columnsOf, type PersonalizationField } from './adapter.ts'
import type { ResolvedValue } from './render.ts'

export interface LeadRecord {
  company: Record<string, unknown> & { id: number; name: string }
  contact: (Record<string, unknown> & { id: number }) | null
  facts: { contact_id: number | null; field: string; value: string; confidence: string | null; checked_at: Date | string }[]
}

const RANK: Record<string, number> = { low: 1, medium: 2, high: 3 }
const rank = (v: unknown) => (typeof v === 'string' ? RANK[v.toLowerCase()] ?? 0 : 0)

function ageDays(at: Date | string | null | undefined, now: Date): number | null {
  if (!at) return null
  const t = new Date(at).getTime()
  return Number.isFinite(t) ? (now.getTime() - t) / 86_400_000 : null
}

/** The lead's facts. contactId null = pick the best contact (verified valid, not a role inbox). */
export async function loadLead(q: Queryable, companyId: number, contactId: number | null): Promise<LeadRecord | null> {
  const co = await q.query<LeadRecord['company']>(`select * from lp.companies where id = $1`, [companyId])
  if (!co.rows[0]) return null
  const ct = await q.query<NonNullable<LeadRecord['contact']>>(
    `select * from lp.contacts where company_id = $1 and ($2::bigint is null or id = $2)
      order by (verification_status = 'valid') desc, coalesce(is_role_address, false), do_not_contact, id limit 1`,
    [companyId, contactId],
  )
  const ecols = await columnsOf(q, 'enrichment')
  const checked = ecols.has('last_checked_at') ? 'last_checked_at' : 'created_at'
  const fx = await q.query<LeadRecord['facts'][number]>(
    `select contact_id, field, value, confidence, ${checked} as checked_at from lp.enrichment where company_id = $1`,
    [companyId],
  )
  return {
    company: { ...co.rows[0], id: Number(co.rows[0].id) },
    contact: ct.rows[0] ? { ...ct.rows[0], id: Number(ct.rows[0].id) } : null,
    facts: fx.rows.map((f) => ({ ...f, contact_id: f.contact_id == null ? null : Number(f.contact_id) })),
  }
}

function leadValue(f: PersonalizationField, lead: LeadRecord): string | null {
  const [obj, col] = f.source.split('.', 2)
  if (!col || (obj !== 'contact' && obj !== 'company')) return null
  const row = obj === 'contact' ? lead.contact : lead.company
  if (!row || !/^[a-z_][a-z0-9_]*$/.test(col)) return null
  const v = row[col]
  if (v == null || typeof v === 'object') return null
  const s = String(v).trim()
  if (!s) return null
  // A name with a stated confidence below the field's minimum is not used.
  if (f.min_confidence && obj === 'contact' && (col === 'first_name' || col === 'last_name') && lead.contact?.name_confidence != null) {
    if (rank(lead.contact.name_confidence) < rank(f.min_confidence)) return null
  }
  return s
}

/** The enrichment key a field reads: enrichment:<key>, or the column name for contact./company. sources. */
export function factKey(source: string): string | null {
  if (source.startsWith('enrichment:')) return source.slice('enrichment:'.length) || null
  const col = source.split('.', 2)[1]
  return col || null
}

function factValue(f: PersonalizationField, lead: LeadRecord, now: Date): string | null {
  const key = factKey(f.source)
  if (!key) return null
  const cid = lead.contact?.id ?? null
  const ok = lead.facts.filter(
    (x) =>
      x.field === key &&
      x.value?.trim() &&
      (x.contact_id == null || x.contact_id === cid) &&
      (!f.min_confidence || rank(x.confidence) >= rank(f.min_confidence)) &&
      (f.max_age_days == null || (ageDays(x.checked_at, now) ?? Infinity) <= f.max_age_days),
  )
  ok.sort(
    (a, b) =>
      Number(b.contact_id === cid) - Number(a.contact_id === cid) ||
      rank(b.confidence) - rank(a.confidence) ||
      new Date(b.checked_at).getTime() - new Date(a.checked_at).getTime(),
  )
  return ok[0]?.value.trim() ?? null
}

export function resolveValues(
  fields: PersonalizationField[],
  lead: LeadRecord,
  overrides: Record<string, string>,
  now: Date = new Date(),
): Record<string, ResolvedValue> {
  const ov = new Map(Object.entries(overrides).map(([k, v]) => [k.toLowerCase(), v]))
  const out: Record<string, ResolvedValue> = {}
  for (const f of fields) {
    const o = ov.get(f.name.toLowerCase())
    if (o != null && o.trim()) {
      out[f.name] = { value: o.trim(), source: 'override', real: true }
      continue
    }
    const lv = f.source.startsWith('enrichment:') ? null : leadValue(f, lead)
    if (lv) {
      out[f.name] = { value: lv, source: 'lead', real: true }
      continue
    }
    const ev = factValue(f, lead, now)
    if (ev) {
      out[f.name] = { value: ev, source: 'enrichment', real: true }
      continue
    }
    const fb = f.fallback?.trim()
    out[f.name] = fb ? { value: fb, source: 'fallback', real: false } : { value: null, source: null, real: false }
  }
  return out
}
