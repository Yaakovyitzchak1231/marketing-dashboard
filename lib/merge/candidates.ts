/**
 * Duplicate-candidate finding for merge (plan 1.9). Keys are recomputed live
 * from the raw fields with the current lib/leads/normalize.ts, not read off
 * the stored website_domain/phone_e164/name_addr_key/email_norm columns --
 * those are exactly what the unique dedupe indexes enforce uniqueness on, so
 * a stored-column match can basically never have more than one live row.
 * Real near-duplicates show up because the stored value drifted from what the
 * normalizer produces today, or because one of the paired rows is missing a
 * field the other has. Recomputing catches both.
 */
import type { Queryable } from '../db/types'
import { nameAddressKey, normalizeDomain, normalizeEmail, normalizePhone } from '../leads/normalize'

export type MergeEntity = 'company' | 'contact'
export type MergeRule = 'domain' | 'phone' | 'name_addr' | 'email'

export interface CandidateSide {
  id: number
  name: string | null
  city: string | null
  state: string | null
  website: string | null
  phone: string | null
  updated_at: string
}

export interface MergeCandidate {
  entity: MergeEntity
  a: CandidateSide
  b: CandidateSide
  rules: MergeRule[]
  matched_value: string
}

interface CompanyRow {
  id: number
  name: string
  city: string | null
  state: string | null
  address_line: string | null
  website: string | null
  phone: string | null
  updated_at: string
}

function toSide(c: CompanyRow): CandidateSide {
  return { id: c.id, name: c.name, city: c.city, state: c.state, website: c.website, phone: c.phone, updated_at: c.updated_at }
}

function groupBy<K>(rows: CompanyRow[], key: (c: CompanyRow) => K | null): Map<K, CompanyRow[]> {
  const m = new Map<K, CompanyRow[]>()
  for (const r of rows) {
    const k = key(r)
    if (k === null) continue
    const arr = m.get(k)
    if (arr) arr.push(r)
    else m.set(k, [r])
  }
  return m
}

/** Every unordered pair within a group, newest-updated first. */
function pairsOf(rows: CompanyRow[]): [CompanyRow, CompanyRow][] {
  const sorted = [...rows].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
  const out: [CompanyRow, CompanyRow][] = []
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) out.push([sorted[i], sorted[j]])
  return out
}

/** Candidate duplicate COMPANIES: same recomputed domain, phone, or name+address key. */
export async function findCompanyCandidates(q: Queryable, limit = 50): Promise<MergeCandidate[]> {
  const { rows } = await q.query<CompanyRow>(
    `select id, name, city, state, address_line, website, phone, updated_at
       from lp.companies where merged_into is null order by updated_at desc limit 5000`,
  )
  const byDomain = groupBy(rows, (c) => normalizeDomain(c.website))
  const byPhone = groupBy(rows, (c) => normalizePhone(c.phone))
  const byKey = groupBy(rows, (c) => nameAddressKey(c.name, c.address_line, c.city, c.state))

  const pairKey = (a: CompanyRow, b: CompanyRow) => (a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`)
  const merged = new Map<string, { a: CompanyRow; b: CompanyRow; rules: Set<MergeRule>; values: Map<MergeRule, string> }>()

  function addGroup(groups: Map<string, CompanyRow[]>, rule: MergeRule) {
    for (const [value, members] of groups) {
      if (members.length < 2) continue
      for (const [a, b] of pairsOf(members)) {
        const k = pairKey(a, b)
        let entry = merged.get(k)
        if (!entry) {
          entry = { a, b, rules: new Set(), values: new Map() }
          merged.set(k, entry)
        }
        entry.rules.add(rule)
        entry.values.set(rule, value)
      }
    }
  }
  addGroup(byDomain, 'domain')
  addGroup(byPhone, 'phone')
  addGroup(byKey, 'name_addr')

  const out: MergeCandidate[] = [...merged.values()]
    .sort((x, y) => y.rules.size - x.rules.size)
    .slice(0, limit)
    .map((e) => ({
      entity: 'company' as const,
      a: toSide(e.a),
      b: toSide(e.b),
      rules: [...e.rules],
      matched_value: [...e.values.values()][0] ?? '',
    }))
  return out
}

interface ContactRow {
  id: number
  company_id: number
  email: string | null
  company_name: string | null
  city: string | null
  state: string | null
  updated_at: string
}

/** Candidate duplicate CONTACTS: same recomputed email, across two live (non-merged) rows. */
export async function findContactCandidates(q: Queryable, limit = 50): Promise<MergeCandidate[]> {
  const { rows } = await q.query<ContactRow>(
    `select ct.id, ct.company_id, ct.email, co.name as company_name, co.city, co.state, ct.updated_at
       from lp.contacts ct join lp.companies co on co.id = ct.company_id
      where ct.merged_into is null and co.merged_into is null
      order by ct.updated_at desc limit 5000`,
  )
  const byEmail = new Map<string, ContactRow[]>()
  for (const r of rows) {
    const e = normalizeEmail(r.email)
    if (!e) continue
    const arr = byEmail.get(e)
    if (arr) arr.push(r)
    else byEmail.set(e, [r])
  }
  const out: MergeCandidate[] = []
  for (const [email, members] of byEmail) {
    if (members.length < 2) continue
    const sorted = [...members].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    for (let i = 0; i < sorted.length && out.length < limit; i++) {
      for (let j = i + 1; j < sorted.length && out.length < limit; j++) {
        const a = sorted[i]
        const b = sorted[j]
        out.push({
          entity: 'contact',
          a: { id: a.id, name: a.company_name, city: a.city, state: a.state, website: null, phone: null, updated_at: a.updated_at },
          b: { id: b.id, name: b.company_name, city: b.city, state: b.state, website: null, phone: null, updated_at: b.updated_at },
          rules: ['email'],
          matched_value: email,
        })
      }
    }
  }
  return out
}

export async function findCandidates(q: Queryable, entity: MergeEntity, limit = 50): Promise<MergeCandidate[]> {
  return entity === 'company' ? findCompanyCandidates(q, limit) : findContactCandidates(q, limit)
}
