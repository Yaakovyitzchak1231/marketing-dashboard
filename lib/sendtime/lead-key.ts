/**
 * The one place a send-time lead key is built or read.
 *
 * Convention (matches what main already uses): `contact:<id>` when the lead
 * is a contact, else `company:<id>`. This is the same shape as
 * lp.trigger_watch.member_key (db/migrations/0053_journey_triggers.sql, built
 * by memberKey in lib/triggers/match.ts) and the tail of the composite-event
 * dedupe keys (`composite:<type>:contact:<id>`, lib/events/composite.ts), so a
 * key can be joined or compared across those without translation.
 *
 * Not the same as the `<company_id>:<contact_id>` composite that the
 * unmerged A/B-experiments branch (0061 experiment_assignments) generates:
 * that one is not on main, and it encodes a company AND a contact, where a
 * send window belongs to exactly one lead. If experiments merge first, join
 * through parseLeadKey rather than string-munging.
 */
export class SendTimeError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'SendTimeError'
    this.status = status
  }
}

/** Same pattern as the lp.lead_send_windows.lead_key check constraint. */
export const LEAD_KEY_RE = /^(company|contact):([0-9]+)$/

export type LeadKind = 'company' | 'contact'

/** The most specific key for a lead: a contact when there is one, else the company. */
export function leadKey(companyId?: number | null, contactId?: number | null): string {
  if (contactId != null) {
    if (!Number.isInteger(contactId) || contactId <= 0) throw new SendTimeError('contact_id must be a positive integer.')
    return `contact:${contactId}`
  }
  if (companyId == null || !Number.isInteger(companyId) || companyId <= 0) {
    throw new SendTimeError('Give a company_id or contact_id.')
  }
  return `company:${companyId}`
}

/** Inverse of leadKey. Throws SendTimeError on anything that is not `company:<id>` / `contact:<id>`. */
export function parseLeadKey(key: string): { kind: LeadKind; id: number } {
  const m = LEAD_KEY_RE.exec(key)
  if (!m) throw new SendTimeError(`Bad lead key "${key}".`)
  const id = Number(m[2])
  if (!Number.isSafeInteger(id) || id <= 0) throw new SendTimeError(`Bad lead key "${key}".`)
  return { kind: m[1] as LeadKind, id }
}
