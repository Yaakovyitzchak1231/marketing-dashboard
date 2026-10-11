/** What a person can edit on a lead. Re-exported from lib/edit/registry.ts, the universal
 *  inline-edit whitelist (plan item 1.3) — this file stays so existing imports keep working. */
export {
  CONTACT_EDIT_FIELDS,
  COMPANY_EDIT_FIELDS,
  EDITABLE_CONTACT_STATUSES,
  STATUSES_RESET_BY_EMAIL_CHANGE,
  FIELD_LABELS,
} from '../edit/registry'
export type { ContactEditField, CompanyEditField, ContactPatch, CompanyPatch } from '../edit/registry'
