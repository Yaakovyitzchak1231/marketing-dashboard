/**
 * Editing a lead by hand (the lead page's Edit buttons, a signed-in human).
 *
 * Every save:
 *  - validates and normalizes what was typed (email, phone, website),
 *  - writes only the fields that actually changed,
 *  - writes one lp.status_history row per changed field with the actor (status and
 *    email-status rows come from the database trigger, other fields from here),
 *  - logs one plain-English activity event with every old -> new value.
 *
 * Changing an email re-normalizes it and resets its verification (it is a new,
 * unchecked address). Statuses that only described the old address's check
 * (verifying, valid-ready, catch-all-hold) go back to 'new'. Every other status,
 * role-based-hold above all, is kept exactly as it was: nothing here converts a
 * held lead into anything else unless the person picks a new status themselves.
 */
import type { Queryable } from '@/lib/db/types'
import { logEvent } from '@/lib/ops/events'
import { actorName } from './queries'
import { isRoleAddress, nameAddressKey, normalizeDomain, normalizeEmail, normalizePhone } from './normalize'
import type { CompanyRow, ContactRow } from './types'
import { EDITABLE_CONTACT_STATUSES, STATUSES_RESET_BY_EMAIL_CHANGE, FIELD_LABELS, type CompanyPatch, type ContactPatch } from './edit-fields'

export {
  EDITABLE_CONTACT_STATUSES, STATUSES_RESET_BY_EMAIL_CHANGE, CONTACT_EDIT_FIELDS, COMPANY_EDIT_FIELDS, FIELD_LABELS,
} from './edit-fields'
export type { ContactEditField, CompanyEditField, ContactPatch, CompanyPatch } from './edit-fields'

export interface FieldChange {
  field: string
  from: string | null
  to: string | null
}

export interface EditResult {
  changes: FieldChange[]
  /** True when an email change reset the address's verification. */
  verification_reset: boolean
}

export class LeadEditError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message)
  }
}

type Tx = { tx<T>(fn: (q: Queryable) => Promise<T>, actor?: string): Promise<T> }

const MAX_LEN: Record<string, number> = {
  first_name: 100, last_name: 100, title: 200, email: 320, phone: 40,
  name: 200, website: 500, city: 100, state: 50,
}

/** Trim; blank becomes null. Rejects anything that is not a string or null. */
function clean(field: string, v: unknown): string | null {
  if (v === null) return null
  if (typeof v !== 'string') throw new LeadEditError(`${FIELD_LABELS[field] ?? field} must be text.`, 400)
  const s = v.trim().replace(/\s+/g, ' ')
  if (!s) return null
  if (s.length > (MAX_LEN[field] ?? 200)) throw new LeadEditError(`${FIELD_LABELS[field] ?? field} is too long.`, 400)
  return s
}

/** Pick the known fields out of a request body; unknown keys are a 400, not silently ignored. */
export function parsePatch<F extends string>(body: unknown, fields: readonly F[]): Partial<Record<F, string | null>> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LeadEditError('Send the fields to change as JSON.', 400)
  const out: Partial<Record<F, string | null>> = {}
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!(fields as readonly string[]).includes(k)) throw new LeadEditError(`${k} can't be edited here.`, 400)
    out[k as F] = clean(k, v)
  }
  if (!Object.keys(out).length) throw new LeadEditError('Nothing to change.', 400)
  return out
}

/** The same trimming parsePatch does, for callers that pass a patch directly. */
function tidy<P extends Record<string, string | null | undefined>>(patch: P): P {
  return Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === undefined ? null : clean(k, v)])) as P
}

function phoneOrThrow(v: string | null): string | null {
  if (v === null) return null
  const e164 = normalizePhone(v)
  if (!e164) throw new LeadEditError(`"${v}" doesn't look like a phone number. Use 10 digits, or +country code.`, 400)
  return e164
}

/** The stored value as the form would show it, so an untouched field never counts as a change. */
function same(stored: string | null, next: string | null): boolean {
  const a = stored == null ? null : stored.trim().replace(/\s+/g, ' ') || null
  return a === next
}

function shown(v: string | null): string {
  return v === null || v === '' ? '(blank)' : v
}

function summarize(who: string, what: string, changes: FieldChange[]): string {
  const parts = changes.map((c) => `${(FIELD_LABELS[c.field] ?? c.field).toLowerCase()} ${shown(c.from)} → ${shown(c.to)}`)
  return `${who} edited ${what}: ${parts.join('; ')}`
}

async function writeHistory(q: Queryable, entity: 'company' | 'contact', id: number, changes: FieldChange[], actor: string) {
  for (const c of changes) {
    // status and verification_status rows are written by the trigger (lp.log_contact_status).
    if (c.field === 'status' || c.field === 'verification_status') continue
    await q.query(
      `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [entity, id, c.field, c.from, c.to, actor],
    )
  }
}

type ContactWithPhone = ContactRow & { phone: string | null; phone_e164: string | null }

/** Edit one contact of one lead. `actor` is the signed-in human ('owner'). */
export async function editContact(
  db: Tx,
  companyId: number,
  contactId: number,
  patch: ContactPatch,
  actor: string,
): Promise<EditResult & { contact: ContactWithPhone }> {
  patch = tidy(patch)
  return db.tx(async (q) => {
    const found = await q.query<ContactWithPhone & { company_name: string }>(
      `select ct.*, co.name as company_name from lp.contacts ct join lp.companies co on co.id = ct.company_id
        where ct.id = $1 and ct.company_id = $2 for update of ct`,
      [contactId, companyId],
    )
    const cur = found.rows[0]
    if (!cur) throw new LeadEditError('No such contact on this lead.', 404)

    const set: Record<string, unknown> = {}
    const changes: FieldChange[] = []
    let verificationReset = false

    for (const f of ['first_name', 'last_name', 'title'] as const) {
      if (!(f in patch)) continue
      const next = patch[f] ?? null
      if (!same(cur[f], next)) {
        set[f] = next
        changes.push({ field: f, from: cur[f], to: next })
      }
    }
    if ('first_name' in set || 'last_name' in set) set.name_source = 'manual'

    if ('phone' in patch) {
      const next = patch.phone ?? null
      if (!same(cur.phone, next)) {
        set.phone = next
        set.phone_e164 = phoneOrThrow(next)
        changes.push({ field: 'phone', from: cur.phone, to: next })
      }
    }

    let status = cur.status as string
    if ('status' in patch) {
      const next = patch.status
      if (!next || !(EDITABLE_CONTACT_STATUSES as readonly string[]).includes(next)) {
        throw new LeadEditError(`Status must be one of: ${EDITABLE_CONTACT_STATUSES.join(', ')}.`, 400)
      }
      status = next
    }

    if ('email' in patch) {
      const raw = patch.email ?? null
      const curNorm = cur.email_norm ?? normalizeEmail(cur.email)
      if (raw === null) {
        if (cur.email !== null) throw new LeadEditError('Email can’t be blank. Change it to the right address instead.', 400)
      } else {
        const norm = normalizeEmail(raw)
        if (!norm) throw new LeadEditError(`"${raw}" is not a valid email address.`, 400)
        if (norm !== curNorm) {
          const dup = await q.query<{ company_id: number | null; name: string | null }>(
            `select ct.company_id, co.name from lp.contacts ct left join lp.companies co on co.id = ct.company_id
              where ct.email_norm = $1 and ct.id <> $2 limit 1`,
            [norm, contactId],
          )
          if (dup.rows[0]) {
            const d = dup.rows[0]
            throw new LeadEditError(
              `${norm} is already a contact on ${d.name ?? 'another lead'}${d.company_id ? ` (/leads/${d.company_id})` : ''}.`,
              409,
            )
          }
          set.email = norm
          set.email_norm = norm
          set.email_source = 'manual'
          set.is_role_address = isRoleAddress(norm)
          set.verification_status = 'unverified'
          set.verified_at = null
          set.verified_by = null
          verificationReset = true
          changes.unshift({ field: 'email', from: cur.email, to: norm })
          if (cur.verification_status !== 'unverified') {
            changes.push({ field: 'verification_status', from: cur.verification_status, to: 'unverified' })
          }
          // A status about the old address's check starts over. Held statuses
          // (role-based-hold, needs-check) and everything else stay as they are.
          const statusPicked = 'status' in patch && patch.status !== cur.status
          if (!statusPicked && STATUSES_RESET_BY_EMAIL_CHANGE.includes(status)) status = 'new'
        }
      }
    }

    if (status !== cur.status) {
      set.status = status
      changes.push({ field: 'status', from: cur.status, to: status })
    }

    if (!changes.length) return { changes, verification_reset: false, contact: stripName(cur) }

    const cols = Object.keys(set)
    const { rows } = await q.query<ContactWithPhone>(
      `update lp.contacts set ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} where id = $${cols.length + 1} returning *`,
      [...cols.map((c) => set[c]), contactId],
    )
    await writeHistory(q, 'contact', contactId, changes, actor)
    const who = await actorName(q, actor)
    const label = cur.email ?? ([cur.first_name, cur.last_name].filter(Boolean).join(' ') || `contact ${contactId}`)
    await logEvent(q, {
      actor,
      kind: 'lead.contact_edited',
      summary: summarize(who, `${label} at ${cur.company_name}`, changes),
      entity_type: 'company',
      entity_id: companyId,
      data: { contact_id: contactId, changes, verification_reset: verificationReset },
    })
    return { changes, verification_reset: verificationReset, contact: rows[0] }
  }, actor)
}

function stripName(row: ContactWithPhone & { company_name?: string }): ContactWithPhone {
  const { company_name: _drop, ...rest } = row
  void _drop
  return rest as ContactWithPhone
}

/** Edit the company (store) fields of one lead. */
export async function editCompany(
  db: Tx,
  companyId: number,
  patch: CompanyPatch,
  actor: string,
): Promise<EditResult & { company: CompanyRow }> {
  patch = tidy(patch)
  return db.tx(async (q) => {
    const found = await q.query<CompanyRow & { address_line: string | null }>(
      `select * from lp.companies where id = $1 for update`,
      [companyId],
    )
    const cur = found.rows[0]
    if (!cur) throw new LeadEditError('No lead with that id.', 404)

    const set: Record<string, unknown> = {}
    const changes: FieldChange[] = []

    if ('name' in patch) {
      const next = patch.name ?? null
      if (next === null) throw new LeadEditError('Name can’t be blank.', 400)
      if (!same(cur.name, next)) {
        set.name = next
        changes.push({ field: 'name', from: cur.name, to: next })
      }
    }
    for (const f of ['city', 'state'] as const) {
      if (!(f in patch)) continue
      let next = patch[f] ?? null
      if (f === 'state' && next && /^[a-z]{2}$/i.test(next)) next = next.toUpperCase()
      if (!same(cur[f], next)) {
        set[f] = next
        changes.push({ field: f, from: cur[f], to: next })
      }
    }
    if ('website' in patch) {
      const next = patch.website ?? null
      if (!same(cur.website, next) && next !== null && !/^(https?:\/\/)?[^\s/@]+\.[^\s/@]{2,}(\/\S*)?$/i.test(next)) {
        throw new LeadEditError(`"${next}" doesn't look like a website address.`, 400)
      }
      if (!same(cur.website, next)) {
        const domain = normalizeDomain(next)
        if (domain && domain !== cur.website_domain) {
          const dup = await q.query<{ id: number; name: string }>(
            `select id, name from lp.companies where website_domain = $1 and id <> $2 limit 1`,
            [domain, companyId],
          )
          if (dup.rows[0]) throw new LeadEditError(`${domain} is already the website of ${dup.rows[0].name} (/leads/${dup.rows[0].id}).`, 409)
        }
        set.website = next
        set.website_domain = domain
        changes.push({ field: 'website', from: cur.website, to: next })
      }
    }
    if ('phone' in patch) {
      const next = patch.phone ?? null
      if (!same(cur.phone, next)) {
        const e164 = phoneOrThrow(next)
        if (e164 && e164 !== cur.phone_e164) {
          const dup = await q.query<{ id: number; name: string }>(
            `select id, name from lp.companies where phone_e164 = $1 and id <> $2 limit 1`,
            [e164, companyId],
          )
          if (dup.rows[0]) throw new LeadEditError(`${next} is already the phone of ${dup.rows[0].name} (/leads/${dup.rows[0].id}).`, 409)
        }
        set.phone = next
        set.phone_e164 = e164
        changes.push({ field: 'phone', from: cur.phone, to: next })
      }
    }

    if (!changes.length) return { changes, verification_reset: false, company: cur }

    if ('name' in set || 'city' in set || 'state' in set) {
      const key = nameAddressKey(
        (set.name as string | undefined) ?? cur.name,
        cur.address_line,
        'city' in set ? (set.city as string | null) : cur.city,
        'state' in set ? (set.state as string | null) : cur.state,
      )
      if (key) {
        const dup = await q.query<{ id: number; name: string }>(
          `select id, name from lp.companies where name_addr_key = $1 and id <> $2 limit 1`,
          [key, companyId],
        )
        if (dup.rows[0]) throw new LeadEditError(`That name and address already belong to ${dup.rows[0].name} (/leads/${dup.rows[0].id}).`, 409)
      }
      set.name_addr_key = key
    }

    const cols = Object.keys(set)
    const { rows } = await q.query<CompanyRow>(
      `update lp.companies set ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} where id = $${cols.length + 1} returning *`,
      [...cols.map((c) => set[c]), companyId],
    )
    await writeHistory(q, 'company', companyId, changes, actor)
    const who = await actorName(q, actor)
    await logEvent(q, {
      actor,
      kind: 'lead.company_edited',
      summary: summarize(who, cur.name, changes),
      entity_type: 'company',
      entity_id: companyId,
      data: { changes },
    })
    return { changes, verification_reset: false, company: rows[0] }
  }, actor)
}
