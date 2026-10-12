/**
 * Bulk edit (plan item 1.3): set one company field on many selected leads.
 * Each lead goes through the very same updateEntity path an InlineEditCell
 * uses, so each change is validated the same way and gets its own
 * lp.status_history (audit log) row. One lead failing (a duplicate website,
 * say) never undoes the others; the result says which.
 */
import type { Db } from '../db/types'
import { REGISTRY, RegistryError, FIELD_LABELS } from './registry'
import { updateEntity } from './update'
import { LeadEditError } from '../leads/edit'
import { BULK_COMPANY_FIELDS, EDITOR_BULK_EDIT_CAP, MAX_BULK_EDIT } from './bulk-fields'

export { BULK_COMPANY_FIELDS, EDITOR_BULK_EDIT_CAP, MAX_BULK_EDIT }

export interface BulkEditResult {
  field: string
  updated: number
  unchanged: number
  failed: { id: number; error: string }[]
  /** Leads never tried because an unexpected (non-validation) error stopped the run. */
  skipped: number
}

export async function bulkUpdateCompanies(
  db: Db,
  actor: string,
  input: { ids: number[]; field: string; value: unknown; isOwner: boolean },
): Promise<BulkEditResult> {
  if (!BULK_COMPANY_FIELDS.includes(input.field)) {
    throw new RegistryError(`"${input.field}" can't be bulk-edited. Fields: ${BULK_COMPANY_FIELDS.join(', ')}.`)
  }
  const ids = [...new Set(input.ids)]
  const cap = input.isOwner ? MAX_BULK_EDIT : EDITOR_BULK_EDIT_CAP
  if (ids.length === 0) throw new RegistryError('Pick at least one lead.')
  if (ids.length > cap) throw new RegistryError(`That is ${ids.length} leads; ${input.isOwner ? 'the limit' : 'an editor can change at most'} ${cap} at once.`, input.isOwner ? 400 : 403)
  // Validate once up front so a bad value fails the whole request, not every row.
  REGISTRY.company![input.field].validate(input.value)
  const out: BulkEditResult = { field: input.field, updated: 0, unchanged: 0, failed: [], skipped: 0 }
  // A merged-away company is a tombstone: the lead lives on as the company it was merged into.
  // Editing it would change a row nobody sees, so it fails by name instead of quietly saving.
  const merged = new Map<number, number>()
  const m = await db.query<{ id: number; merged_into: number }>(
    'select id, merged_into from lp.companies where id = any($1::bigint[]) and merged_into is not null',
    [ids],
  )
  for (const r of m.rows) merged.set(Number(r.id), Number(r.merged_into))
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    const into = merged.get(id)
    if (into !== undefined) {
      out.failed.push({ id, error: `This lead was merged into #${into}; edit that one instead.` })
      continue
    }
    try {
      const r = await updateEntity(db, actor, { type: 'company', id, field: input.field, value: input.value, via: 'ui', note: 'bulk edit' })
      if (r.changed) out.updated++
      else out.unchanged++
    } catch (e) {
      if (e instanceof RegistryError || e instanceof LeadEditError) {
        out.failed.push({ id, error: e.message })
        continue
      }
      // Anything else (database down, a bug): the leads already saved stay saved, so report them
      // rather than throwing them away with a 500, and stop instead of hammering a broken database.
      console.error('bulk edit: unexpected error on company', id, e)
      out.failed.push({ id, error: 'Could not save (server error).' })
      out.skipped = ids.length - i - 1
      break
    }
  }
  return out
}

/** "12 updated, 1 unchanged, 2 failed: #4 That website is already on lead 9; …" */
export function bulkEditSentence(r: BulkEditResult): string {
  const label = FIELD_LABELS[r.field] ?? r.field
  const parts = [`${label}: ${r.updated} updated`, `${r.unchanged} unchanged`]
  if (r.failed.length) {
    const shown = r.failed.slice(0, 3).map((f) => `#${f.id} ${f.error}`).join('; ')
    parts.push(`${r.failed.length} failed: ${shown}${r.failed.length > 3 ? `; and ${r.failed.length - 3} more` : ''}`)
  }
  if (r.skipped) parts.push(`${r.skipped} not tried (stopped after a server error)`)
  return parts.join(', ') + '.'
}
