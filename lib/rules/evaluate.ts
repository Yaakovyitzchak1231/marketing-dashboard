/**
 * The one evaluator. Given a lead (a company, its contacts and its facts) and a
 * rule set, it says Ready-personalized, Ready-generic or Parked, and why.
 * Pure: no database, no clock except the `now` passed in. Everything that
 * shows or uses "Ready" (Overview counts, the lead page, the Add to Instantly
 * preview and confirm, agents' readiness reads) goes through evaluateLead.
 *
 * Order: standing rules first (code, not editable), then the rule set's own
 * requirements in order. Every failed rule is listed, not only the first.
 * The best contact wins: personalized > generic > parked, then a verified
 * email, then a named (non-role) inbox, then the oldest contact.
 */
import {
  CONFIDENCES,
  ENRICHMENT_PREFIX,
  describeRequirement,
  type Confidence,
  type PersonalizationField,
  type Requirement,
} from './schema.ts'
import { standingReasons, type StandingCode } from './standing.ts'

export type Tier = 'ready_personalized' | 'ready_generic' | 'parked'
export const TIERS: readonly Tier[] = ['ready_personalized', 'ready_generic', 'parked']
export const TIER_WORDS: Record<Tier, string> = {
  ready_personalized: 'Ready-personalized',
  ready_generic: 'Ready-generic',
  parked: 'Parked',
}
export const isReady = (t: Tier) => t !== 'parked'

export interface CompanyFacts {
  id: number
  name: string
  segment: string
  vertical: string | null
  website_domain: string | null
  phone_e164: string | null
  city: string | null
  state: string | null
  owner_name: string | null
  stage: string
  research_status: string
  last_researched_at: Date | string | null
  /** Set when the search for the owner's own email was marked exhausted (0010). Releases role-based-hold to Ready-generic. */
  owner_research_exhausted_at?: Date | string | null
}

export interface ContactFacts {
  id: number
  email_norm: string | null
  first_name: string | null
  last_name: string | null
  title: string | null
  phone_e164: string | null
  is_role_address: boolean | null
  email_source: string | null
  name_confidence: string | null
  status: string
  verification_status: string
  verified_at: Date | string | null
  personalization: string | null
  do_not_contact: boolean
  /** Any campaign touch in our records for this contact (Instantly event or an add). */
  touched: boolean
}

export interface FactRow {
  contact_id: number | null
  field: string
  value: string
  confidence: string | null
  last_checked_at: Date | string
}

export interface LeadFacts {
  company: CompanyFacts
  contacts: ContactFacts[]
  facts: FactRow[]
}

export interface RuleSetLike {
  id: number
  version: number
  requirements: Requirement[]
  fields: PersonalizationField[]
}

export interface ParkReason {
  /** The requirement id, or the standing rule's code. */
  rule: string
  label: string
  detail: string
  standing: boolean
}

/** Role inboxes (info@, sales@, role-based-hold) go out only in their own batches, with no-name copy. */
export type Batch = 'standard' | 'role-inbox'

export interface ContactVerdict {
  contact_id: number
  tier: Tier
  batch: Batch
  reasons: ParkReason[]
  merge: Record<string, string>
  missing: string[]
}

export interface LeadVerdict {
  company_id: number
  /** The contact this verdict is for; null when the company has no contact at all. */
  contact_id: number | null
  tier: Tier
  reasons: ParkReason[]
  merge: Record<string, string>
  missing: string[]
  batch: Batch
  /** Every contact's verdict (the lead page shows them all). */
  contacts: ContactVerdict[]
  rule_set_id: number
  version: number
}

const RANK: Record<string, number> = { low: 1, medium: 2, high: 3 }
export function confidenceRank(v: string | null | undefined): number {
  if (!v) return 0
  const s = v.trim().toLowerCase()
  if (s.startsWith('hi')) return 3
  if (s.startsWith('med')) return 2
  if (s.startsWith('lo')) return 1
  return RANK[s] ?? 0
}
const meets = (have: string | null | undefined, min: Confidence | null | undefined) => !min || confidenceRank(have) >= RANK[min]

const DAY = 86_400_000
function ageDays(d: Date | string | null | undefined, now: Date): number | null {
  if (!d) return null
  const t = (d instanceof Date ? d : new Date(d)).getTime()
  if (!Number.isFinite(t)) return null
  return Math.max(0, (now.getTime() - t) / DAY)
}

interface Candidate {
  value: string | boolean | null
  confidence?: string | null
  dated?: Date | string | null
}

/** The values a field has for this contact, before confidence / age filters. */
function candidates(field: string, co: CompanyFacts, ct: ContactFacts | null, facts: FactRow[]): Candidate[] {
  if (field.startsWith(ENRICHMENT_PREFIX)) {
    const key = field.slice(ENRICHMENT_PREFIX.length)
    return facts
      .filter((f) => f.field.toLowerCase() === key && (f.contact_id == null || (ct && f.contact_id === ct.id)))
      .map((f) => ({ value: f.value, confidence: f.confidence, dated: f.last_checked_at }))
  }
  const c = ct
  switch (field) {
    case 'contact.verification_status': return [{ value: c?.verification_status ?? null, dated: c?.verified_at ?? null }]
    case 'contact.status': return [{ value: c?.status ?? null }]
    case 'contact.email': return [{ value: c?.email_norm ?? null }]
    case 'contact.email_source': return [{ value: c?.email_source ?? null }]
    case 'contact.is_role_address': return [{ value: c ? c.is_role_address === true : null }]
    case 'contact.first_name': return [{ value: c?.first_name ?? null, confidence: c?.name_confidence ?? null }]
    case 'contact.last_name': return [{ value: c?.last_name ?? null, confidence: c?.name_confidence ?? null }]
    case 'contact.title': return [{ value: c?.title ?? null }]
    case 'contact.phone': return [{ value: c?.phone_e164 ?? null }]
    case 'contact.personalization': return [{ value: c?.personalization ?? null }]
    case 'company.name': return [{ value: co.name }]
    case 'company.segment': return [{ value: co.segment }]
    case 'company.vertical': return [{ value: co.vertical }]
    case 'company.website_domain': return [{ value: co.website_domain }]
    case 'company.phone': return [{ value: co.phone_e164 }]
    case 'company.city': return [{ value: co.city }]
    case 'company.state': return [{ value: co.state }]
    case 'company.owner_name': return [{ value: co.owner_name, dated: co.last_researched_at }]
    case 'company.stage': return [{ value: co.stage }]
    case 'company.research_status': return [{ value: co.research_status, dated: co.last_researched_at }]
    default: return []
  }
}

const norm = (v: string) => v.trim().toLowerCase()
const filled = (c: Candidate) => c.value !== null && c.value !== undefined && !(typeof c.value === 'string' && c.value.trim() === '')

/** Candidates that pass a rule's confidence and age limits, with why the others did not. */
function usable(cands: Candidate[], min: Confidence | null | undefined, maxAge: number | null | undefined, now: Date) {
  const ok: Candidate[] = []
  let lowConf = 0
  let tooOld = 0
  for (const c of cands) {
    if (!filled(c)) continue
    if (!meets(c.confidence, min)) { lowConf++; continue }
    if (maxAge) {
      const a = ageDays(c.dated, now)
      if (a === null || a > maxAge) { tooOld++; continue }
    }
    ok.push(c)
  }
  return { ok, lowConf, tooOld }
}

function shown(cands: Candidate[]): string {
  const vals = cands.filter(filled).map((c) => String(c.value))
  if (!vals.length) return 'empty'
  return vals.length === 1 ? `"${vals[0]}"` : vals.map((v) => `"${v}"`).join(', ')
}

/** Does one requirement hold? Returns null if it does, else the plain-English detail. */
export function checkRequirement(r: Requirement, co: CompanyFacts, ct: ContactFacts | null, facts: FactRow[], now: Date): string | null {
  const all = candidates(r.field, co, ct, facts)
  const { ok, lowConf, tooOld } = usable(all, r.min_confidence, r.max_age_days, now)
  const why = () => {
    const bits = []
    if (lowConf) bits.push(`confidence below ${r.min_confidence}`)
    if (tooOld) bits.push(`not checked in the last ${r.max_age_days} days`)
    return bits.length ? ` (${bits.join('; ')})` : ''
  }
  const list = Array.isArray(r.value) ? r.value.map(norm) : r.value != null ? [norm(String(r.value))] : []
  const vals = ok.map((c) => (typeof c.value === 'boolean' ? c.value : norm(String(c.value))))
  switch (r.op) {
    case 'present':
      return vals.length ? null : `is ${all.some(filled) ? 'not usable' : 'empty'}${why()}`
    case 'absent':
      return vals.length ? `has ${shown(ok)}` : null
    case 'is_true':
      return vals.includes(true) ? null : 'is no'
    case 'is_false':
      return vals.includes(true) ? 'is yes' : null
    case 'eq':
    case 'in':
      return vals.some((v) => typeof v === 'string' && list.includes(v)) ? null : `is ${shown(all)}${why()}`
    case 'neq':
    case 'not_in':
      return vals.some((v) => typeof v === 'string' && list.includes(v)) ? `is ${shown(ok)}` : null
    case 'contains':
      return vals.some((v) => typeof v === 'string' && v.includes(list[0] ?? '')) ? null : `is ${shown(all)}${why()}`
  }
}

/** The value a personalization field would send, or null when there is no real value. */
export function resolveField(f: PersonalizationField, co: CompanyFacts, ct: ContactFacts | null, facts: FactRow[], now: Date): string | null {
  const { ok } = usable(candidates(f.source, co, ct, facts), f.min_confidence, f.max_age_days, now)
  if (!ok.length) return null
  // Best evidence first: highest confidence, then most recently checked.
  let best = ok[0]
  for (let i = 1; i < ok.length; i++) {
    const a = best
    const b = ok[i]
    const diff = confidenceRank(b.confidence) - confidenceRank(a.confidence) || (ageDays(a.dated, now) ?? 1e9) - (ageDays(b.dated, now) ?? 1e9)
    if (diff > 0) best = b
  }
  const v = best.value
  return typeof v === 'string' ? v.trim() : v == null ? null : String(v)
}

/** Sources that carry a person's name: never used for a role inbox (no-name copy). */
const NAME_SOURCES = new Set(['contact.first_name', 'contact.last_name', 'company.owner_name', 'enrichment:owner_name', 'enrichment:person', 'enrichment:first_name'])

export function isRoleInbox(ct: Pick<ContactFacts, 'is_role_address' | 'status'>): boolean {
  return ct.is_role_address === true || ct.status === 'role-based-hold'
}

export function evaluateContact(lead: LeadFacts, ct: ContactFacts, rs: RuleSetLike, now: Date): ContactVerdict {
  const reasons: ParkReason[] = standingReasons(lead.company, ct)
  const roleInbox = isRoleInbox(ct)
  for (const r of rs.requirements) {
    if (!r.enabled) continue
    const d = checkRequirement(r, lead.company, ct, lead.facts, now)
    if (d) reasons.push({ rule: r.id, label: describeRequirement(r), detail: d, standing: false })
  }
  const merge: Record<string, string> = {}
  const missing: string[] = []
  let required = 0
  for (const f of rs.fields) {
    if (!f.enabled) continue
    const v = roleInbox && NAME_SOURCES.has(f.source) ? null : resolveField(f, lead.company, ct, lead.facts, now)
    if (v != null) merge[f.name] = v
    else if (f.fallback) merge[f.name] = f.fallback
    if (f.required) {
      required++
      if (v == null) missing.push(f.name)
    }
  }
  // A role inbox is never Ready-personalized: it gets no-name copy in its own batch.
  const tier: Tier = reasons.length ? 'parked' : !roleInbox && required > 0 && missing.length === 0 ? 'ready_personalized' : 'ready_generic'
  return { contact_id: ct.id, tier, batch: roleInbox ? 'role-inbox' : 'standard', reasons, merge, missing }
}

const TIER_ORDER: Record<Tier, number> = { ready_personalized: 0, ready_generic: 1, parked: 2 }

export function evaluateLead(lead: LeadFacts, rs: RuleSetLike, now: Date = new Date()): LeadVerdict {
  const contacts = lead.contacts.map((ct) => evaluateContact(lead, ct, rs, now))
  if (!contacts.length) {
    const reasons = standingReasons(lead.company, null)
    return { company_id: lead.company.id, contact_id: null, tier: 'parked', batch: 'standard', reasons, merge: {}, missing: [], contacts, rule_set_id: rs.id, version: rs.version }
  }
  const byId = new Map(lead.contacts.map((c) => [c.id, c]))
  let best = contacts[0]
  for (let i = 1; i < contacts.length; i++) {
    const a = best
    const b = contacts[i]
    const ca = byId.get(a.contact_id)!
    const cb = byId.get(b.contact_id)!
    const diff =
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      Number(cb.verification_status === 'valid') - Number(ca.verification_status === 'valid') ||
      Number(ca.is_role_address === true) - Number(cb.is_role_address === true) ||
      a.reasons.length - b.reasons.length ||
      a.contact_id - b.contact_id
    if (diff > 0) best = b
  }
  return {
    company_id: lead.company.id,
    contact_id: best.contact_id,
    tier: best.tier,
    reasons: best.reasons,
    merge: best.merge,
    missing: best.missing,
    batch: best.batch,
    contacts,
    rule_set_id: rs.id,
    version: rs.version,
  }
}

/** The standing code of the first standing reason, if any (for callers that map to their own words). */
export function firstStanding(v: { reasons: ParkReason[] }): StandingCode | null {
  const s = v.reasons.find((r) => r.standing)
  return (s?.rule as StandingCode) ?? null
}

export { CONFIDENCES }
