/** What a person can edit on a lead. Plain constants: shared by the server and the edit form. */
import { CONTACT_STATUSES } from './types'

/** Every status a person can pick: the full list, held statuses included (migration 0006). */
export const EDITABLE_CONTACT_STATUSES = CONTACT_STATUSES

/** Statuses that only say how the OLD email's check went; a new email starts over. */
export const STATUSES_RESET_BY_EMAIL_CHANGE: readonly string[] = ['verifying', 'valid-ready', 'catch-all-hold']

export const CONTACT_EDIT_FIELDS = ['first_name', 'last_name', 'email', 'title', 'phone', 'status'] as const
export const COMPANY_EDIT_FIELDS = ['name', 'website', 'phone', 'city', 'state'] as const
export type ContactEditField = (typeof CONTACT_EDIT_FIELDS)[number]
export type CompanyEditField = (typeof COMPANY_EDIT_FIELDS)[number]
export type ContactPatch = Partial<Record<ContactEditField, string | null>>
export type CompanyPatch = Partial<Record<CompanyEditField, string | null>>

export const FIELD_LABELS: Record<string, string> = {
  first_name: 'First name', last_name: 'Last name', email: 'Email', title: 'Title', phone: 'Phone',
  status: 'Status', name: 'Name', website: 'Website', city: 'City', state: 'State',
  verification_status: 'Email status', stage: 'Stage',
}

