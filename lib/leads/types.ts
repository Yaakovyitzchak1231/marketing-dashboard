/** Row shapes of the lp schema, as the app reads them. Keep in sync with db/migrations. */

export const STAGES = [
  'new', 'researched', 'ready', 'in_campaign', 'contacted', 'replied', 'interested', 'meeting', 'won', 'lost', 'do_not_contact',
] as const
export type Stage = (typeof STAGES)[number]

export const RESEARCH_STATUSES = ['needs_research', 'queued', 'researching', 'researched', 'failed', 'skipped'] as const
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number]

export const CONTACT_STATUSES = [
  'new', 'verifying', 'valid-ready', 'catch-all-hold', 'guessed-hold', 'role-based-hold', 'needs-check',
  'rejected', 'in-Instantly', 'sent', 'replied', 'bounced', 'do-not-contact',
] as const
export type ContactStatus = (typeof CONTACT_STATUSES)[number]

/**
 * Held leads that are KEPT (never rejected, excluded from the list or hidden), but
 * not sent until a person or agent clears them:
 *   role-based-hold  a role inbox (info@, sales@...): find the owner's direct email;
 *                    the role inbox stays on the company as the fallback contact
 *   needs-check      a person has to look before anything is sent
 * A verification verdict never moves these (see PRE_SEND_STATUSES), and
 * "Add to Instantly" lists them as excluded: on hold.
 */
export const HELD_STATUSES: readonly string[] = ['role-based-hold', 'needs-check']

export const VERIFICATION_STATUSES = ['unverified', 'valid', 'invalid', 'catch_all', 'unknown', 'risky'] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

export interface CompanyRow {
  id: number
  name: string
  segment: 'jeweler' | 'ai_agency' | 'other'
  vertical: string | null
  website: string | null
  website_domain: string | null
  phone: string | null
  phone_e164: string | null
  address_line: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string
  owner_name: string | null
  stage: Stage
  research_status: ResearchStatus
  last_researched_at: Date | null
  notes: string | null
  created_at: Date
  updated_at: Date
}

export interface ContactRow {
  id: number
  company_id: number | null
  email: string | null
  email_norm: string | null
  first_name: string | null
  last_name: string | null
  suggested_first_name: string | null
  title: string | null
  is_role_address: boolean | null
  email_source: string | null
  name_source: string | null
  name_confidence: string | null
  name_evidence_url: string | null
  status: ContactStatus
  verification_status: VerificationStatus
  verified_at: Date | null
  verified_by: string | null
  personalization: string | null
  do_not_contact: boolean
  created_at: Date
  updated_at: Date
}

/** Verification verdicts used across precheck / MV / ZB (lp.verification_results.verdict). */
export type Verdict = 'valid' | 'invalid' | 'catch_all' | 'unknown' | 'risky' | 'pass'
