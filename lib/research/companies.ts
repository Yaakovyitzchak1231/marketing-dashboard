/**
 * Find-or-create a company by the dedupe keys (website domain, then phone,
 * then normalized name+address). An existing row only gets EMPTY fields
 * filled; nothing a person or an earlier source set is overwritten.
 * Relative imports only (the engine CLI imports this file).
 */
import type { Queryable } from '../db/types.ts'
import { nameAddressKey, normalizeDomain, normalizePhone } from '../leads/normalize.ts'

export interface CompanyInput {
  name: string
  /** Any pool slug in lp.pools — campaign-agnostic. */
  segment?: string
  vertical?: string | null
  website?: string | null
  phone?: string | null
  address_line?: string | null
  city?: string | null
  state?: string | null
  postal_code?: string | null
}

export async function upsertCompany(q: Queryable, c: CompanyInput, actor: string): Promise<{ id: number; created: boolean }> {
  const domain = normalizeDomain(c.website)
  const phone = normalizePhone(c.phone)
  const key = nameAddressKey(c.name, c.address_line, c.city, c.state)
  const found = await q.query<{ id: number; website_domain: string | null; phone_e164: string | null }>(
    `select id, website_domain, phone_e164 from lp.companies
      where ($1::text is not null and website_domain = $1) or ($2::text is not null and phone_e164 = $2) or ($3::text is not null and name_addr_key = $3)
      order by (website_domain is not distinct from $1) desc, (phone_e164 is not distinct from $2) desc, id
      limit 1`,
    [domain, phone, key],
  )
  if (found.rows.length) {
    const ex = found.rows[0]
    const domFree = domain && !ex.website_domain ? !(await q.query('select 1 from lp.companies where website_domain = $1', [domain])).rows.length : false
    const phoneFree = phone && !ex.phone_e164 ? !(await q.query('select 1 from lp.companies where phone_e164 = $1', [phone])).rows.length : false
    await q.query(
      `update lp.companies set
         website = case when $2 then coalesce(website, $3) else website end,
         website_domain = case when $2 then $4 else website_domain end,
         phone = case when $5 then coalesce(phone, $6) else phone end,
         phone_e164 = case when $5 then $7 else phone_e164 end,
         address_line = coalesce(address_line, $8), city = coalesce(city, $9), state = coalesce(state, $10),
         postal_code = coalesce(postal_code, $11), vertical = coalesce(vertical, $12)
       where id = $1`,
      [ex.id, domFree, c.website ?? null, domain, phoneFree, c.phone ?? null, phone, c.address_line ?? null, c.city ?? null, c.state ?? null, c.postal_code ?? null, c.vertical ?? null],
    )
    return { id: ex.id, created: false }
  }
  const ins = await q.query<{ id: number }>(
    `insert into lp.companies (name, segment, vertical, website, website_domain, phone, phone_e164, address_line, city, state, postal_code, name_addr_key, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [c.name.slice(0, 300), c.segment ?? 'jeweler', c.vertical ?? null, c.website ?? null, domain, c.phone ?? null, phone, c.address_line ?? null, c.city ?? null, c.state ?? null, c.postal_code ?? null, key, actor],
  )
  return { id: ins.rows[0].id, created: true }
}
