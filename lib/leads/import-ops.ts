/**
 * CSV import ops for agents (POST /api/ops {op, ...}) and the dashboard's
 * import page (plan item 1.13). See lib/leads/csv-import.ts for the logic.
 */
import type { Db } from '../db/types'
import { OpsError } from '../ops/core'
import { CsvImportError, runCsvImport } from './csv-import'
import { csvObjects } from './csv'
import { FieldError } from '../fields/store'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof CsvImportError) throw new OpsError(e.message, e.status)
      if (e instanceof FieldError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

function mappingArg(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new OpsError('mapping must be an object of {csv column: target field}')
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, String(val ?? '')]))
}

export const IMPORT_OPS: Record<string, Op> = {
  import_csv: {
    args: '{csv: string, mapping: {csv_column: target_field}, pool?, campaign_id?, dry_run?, overwrite?}  ' +
      '-- overwrite (default false): replace names/titles/custom values an existing lead already has (each change is audited); otherwise only empty fields are filled  ' +
      '-- target_field: email|first_name|last_name|title|phone|company_name|website|company_phone|city|state|contact_custom.<key>|company_custom.<key>',
    run: wrap((db, actor, a) => {
      const text = String(a.csv ?? '')
      if (!text.trim()) throw new OpsError('csv is required')
      const rows = csvObjects(text)
      return runCsvImport(db, rows, {
        mapping: mappingArg(a.mapping),
        pool: typeof a.pool === 'string' ? a.pool : null,
        campaign_id: a.campaign_id == null || a.campaign_id === '' ? null : Number(a.campaign_id),
        actor,
        via: 'ops_api',
        dryRun: a.dry_run === true || a.dry_run === 'true',
        overwrite: a.overwrite === true || a.overwrite === 'true',
      })
    }),
  },
}
