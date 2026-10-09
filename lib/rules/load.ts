/** Read the facts the evaluator needs for a set of companies, in three queries. */
import type { Queryable } from '../db/types.ts'
import type { CompanyFacts, ContactFacts, FactRow, LeadFacts } from './evaluate.ts'

export async function loadLeadFacts(q: Queryable, companyIds: number[]): Promise<Map<number, LeadFacts>> {
  const ids = [...new Set(companyIds.filter((n) => Number.isInteger(n) && n > 0))]
  const out = new Map<number, LeadFacts>()
  if (!ids.length) return out
  const [co, ct, fx] = await Promise.all([
    q.query<CompanyFacts>(
      `select id, name, segment, vertical, website_domain, phone_e164, city, state, owner_name, stage, research_status, last_researched_at,
              owner_research_exhausted_at
         from lp.companies where id = any($1::bigint[])`,
      [ids],
    ),
    q.query<ContactFacts & { company_id: number }>(
      `select ct.id, ct.company_id, ct.email_norm, ct.first_name, ct.last_name, ct.title, ct.phone_e164, ct.is_role_address,
              ct.email_source, ct.name_confidence, ct.status, ct.verification_status, ct.verified_at, ct.personalization,
              ct.do_not_contact,
              exists (select 1 from lp.campaign_touches t where t.contact_id = ct.id and t.campaign_id is not null) as touched
         from lp.contacts ct where ct.company_id = any($1::bigint[]) order by ct.id`,
      [ids],
    ),
    q.query<FactRow & { company_id: number }>(
      `select company_id, contact_id, field, value, confidence, last_checked_at
         from lp.enrichment where company_id = any($1::bigint[])`,
      [ids],
    ),
  ])
  for (const c of co.rows) out.set(Number(c.id), { company: { ...c, id: Number(c.id) }, contacts: [], facts: [] })
  for (const c of ct.rows) {
    const { company_id, ...rest } = c
    out.get(Number(company_id))?.contacts.push({ ...rest, id: Number(rest.id), touched: Boolean(rest.touched), do_not_contact: Boolean(rest.do_not_contact) })
  }
  for (const f of fx.rows) {
    const { company_id, ...rest } = f
    out.get(Number(company_id))?.facts.push({ ...rest, contact_id: rest.contact_id == null ? null : Number(rest.contact_id) })
  }
  return out
}
