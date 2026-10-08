import type { Queryable } from '@/lib/db/types'

export interface FxCompany {
  name: string
  state?: string | null
  city?: string | null
  stage?: string
  segment?: string
  research_status?: string
  owner_name?: string | null
  domain?: string | null
}

export async function addCompany(q: Queryable, c: FxCompany): Promise<number> {
  const { rows } = await q.query<{ id: number }>(
    `insert into lp.companies (name, state, city, stage, segment, research_status, owner_name, website_domain, website)
     values ($1, $2, $3, coalesce($4, 'new'), coalesce($5, 'jeweler'), coalesce($6, 'needs_research'), $7, $8, $9) returning id`,
    [c.name, c.state ?? null, c.city ?? null, c.stage ?? null, c.segment ?? null, c.research_status ?? null, c.owner_name ?? null,
     c.domain ?? null, c.domain ? `https://${c.domain}` : null],
  )
  return rows[0].id
}

export async function addContact(
  q: Queryable,
  companyId: number,
  email: string,
  verification = 'unverified',
  extra: { status?: string; role?: boolean } = {},
): Promise<number> {
  const { rows } = await q.query<{ id: number }>(
    `insert into lp.contacts (company_id, email, email_norm, verification_status, status, is_role_address)
     values ($1, $2, lower($2), $3, coalesce($4, 'new'), $5) returning id`,
    [companyId, email, verification, extra.status ?? null, extra.role ?? false],
  )
  return rows[0].id
}

let ext = 0
export async function addTouch(
  q: Queryable,
  t: { companyId?: number | null; contactId?: number | null; email?: string; campaign?: string | null; event: string; at: string; payload?: Record<string, unknown> },
): Promise<number> {
  const { rows } = await q.query<{ id: number }>(
    `insert into lp.campaign_touches (company_id, contact_id, email, campaign_name, event_type, occurred_at, source, external_id, payload)
     values ($1, $2, $3, $4, $5, $6, 'instantly_webhook', $7, $8) returning id`,
    [t.companyId ?? null, t.contactId ?? null, t.email ?? null, t.campaign ?? null, t.event, t.at, `fx-${++ext}`,
     t.payload ? JSON.stringify(t.payload) : null],
  )
  return rows[0].id
}
