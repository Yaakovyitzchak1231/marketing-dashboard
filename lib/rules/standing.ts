/**
 * Standing rules: code, not settings. No rule set can switch these off, and the
 * Rules page shows them as fixed. They come from Yaakov's standing rules:
 *
 *  - role-based-hold and needs-check are HELD: parked with a reason, never
 *    rejected, never thrown out, never converted. The evaluator never writes a
 *    contact's status at all; "parked" is a computed state, not a status.
 *    Exception (Yaakov, Oct 9 2026): once owner research is marked exhausted for
 *    the store, a role-based-hold inbox scores Ready-generic and is sent only in
 *    its own "role-inbox" batches (no-name copy). needs-check always waits.
 *  - only Ready leads can be uploaded (add-leads uses this evaluator at preview
 *    and again at confirm);
 *  - an email must have been through verification (free checks, then
 *    MillionVerifier, then ZeroBounce; that order lives in lib/verify and is not
 *    touched here) and not failed it. Which verdicts count (valid only, or also
 *    catch-all) is the editable "Email status" requirement.
 *  - do-not-contact, and anyone already in a campaign, are never Ready.
 */
import { HELD_STATUSES } from '../leads/types.ts'

export type StandingCode = 'no_email' | 'do_not_contact' | 'on_hold' | 'invalid' | 'not_verified' | 'already_in_campaign' | 'rejected'

export const STANDING_RULES: { code: StandingCode; label: string }[] = [
  { code: 'no_email', label: 'Has an email address' },
  { code: 'do_not_contact', label: 'Not marked do-not-contact' },
  { code: 'on_hold', label: 'Not on hold: needs-check waits for a person; role-based-hold waits until owner research is marked exhausted, then goes out only in role-inbox batches. Held leads are kept, never rejected.' },
  { code: 'invalid', label: 'Email did not fail verification' },
  { code: 'not_verified', label: 'Email has been verified (free checks, then MillionVerifier, then ZeroBounce)' },
  { code: 'rejected', label: 'Not rejected' },
  { code: 'already_in_campaign', label: 'Not already in a campaign (in Instantly, sent, replied or bounced)' },
]

const LABEL = Object.fromEntries(STANDING_RULES.map((r) => [r.code, r.label])) as Record<StandingCode, string>

interface Co { stage: string; owner_research_exhausted_at?: Date | string | null }
interface Ct { email_norm: string | null; do_not_contact: boolean; status: string; verification_status: string; touched: boolean }

function reason(code: StandingCode, detail: string) {
  return { rule: code, label: LABEL[code], detail, standing: true }
}

export function standingReasons(co: Co, ct: Ct | null) {
  if (!ct) return [reason('no_email', 'no contact on this lead')]
  const out = []
  if (!ct.email_norm) out.push(reason('no_email', 'no email address'))
  if (ct.do_not_contact || ct.status === 'do-not-contact' || co.stage === 'do_not_contact') out.push(reason('do_not_contact', 'marked do-not-contact'))
  // role-based-hold is released (to Ready-generic, role-inbox batch only) once owner research is marked exhausted
  // for the store; needs-check always waits for a person.
  const released = ct.status === 'role-based-hold' && Boolean(co.owner_research_exhausted_at)
  if (HELD_STATUSES.includes(ct.status) && !released) {
    out.push(reason('on_hold', ct.status === 'role-based-hold' ? 'role-based-hold: kept until owner research is marked exhausted for this store' : `status is ${ct.status} (kept, not sent until a person clears it)`))
  }
  if (ct.verification_status === 'invalid') out.push(reason('invalid', 'email failed verification'))
  else if (ct.verification_status === 'unverified' || ct.status === 'verifying') out.push(reason('not_verified', 'email not verified yet'))
  if (ct.status === 'rejected') out.push(reason('rejected', 'status is rejected'))
  if (ct.touched || ['in-Instantly', 'sent', 'replied', 'bounced'].includes(ct.status)) out.push(reason('already_in_campaign', 'already in a campaign'))
  return out
}
