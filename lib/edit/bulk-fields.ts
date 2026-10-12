/**
 * Which company fields the bulk bar's "Edit field" offers (client-safe; no DB).
 * The inline-edit whitelist in registry.ts, minus stage — the bar's own
 * "Set stage" control already owns that one — and minus name: giving many
 * leads the same name is never what someone means. Website stays: a value
 * already on another lead fails per row with the duplicate message, and the
 * rest still save.
 */
import { REGISTRY } from './registry'

export const BULK_COMPANY_FIELDS: readonly string[] = Object.keys(REGISTRY.company ?? {}).filter((f) => f !== 'stage' && f !== 'name')

export const BULK_FIELD_CHOICES: readonly { value: string; label: string }[] = BULK_COMPANY_FIELDS.map((f) => ({
  value: f,
  label: REGISTRY.company![f].label,
}))

/** Most leads an Editor may change in one bulk edit (same cap as tag changes, lib/tags/store.ts). */
export const EDITOR_BULK_EDIT_CAP = 500
/** Hard ceiling for anyone, owners included (the same size limit the stage route uses). */
export const MAX_BULK_EDIT = 5000
