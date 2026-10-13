/**
 * The Lead Master copy: the lead database written back out, read-only, as a
 * CSV or into a NEW tab of the Lead Master Google Sheet.
 *
 * Never touches the existing "Leads" tab (Lead Master is append-only): the
 * Sheet writer only ever clears and rewrites a tab whose name starts with
 * "DB export", and refuses anything else before a request is made. Running it
 * twice gives the same tab (it is a full overwrite), so it is safe to schedule.
 */
import type { Queryable } from '../db/types.ts'

export const EXPORT_COLUMNS = [
  'email',
  'first_name',
  'last_name',
  'company',
  'website',
  'phone',
  'city',
  'state',
  'segment',
  'company_stage',
  'contact_status',
  'verification_status',
  'verified_by',
  'verified_at',
  'do_not_contact',
  'owner_name',
  'name_source',
  'last_campaign',
  'last_event',
  'last_event_at',
  'lead_id',
  'contact_id',
  'updated_at',
] as const

export type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], string>

const SQL = `
  select ct.email, ct.first_name, ct.last_name, co.name as company, co.website, co.phone, co.city, co.state,
         co.segment, co.stage as company_stage, ct.status as contact_status, ct.verification_status, ct.verified_by,
         to_char(ct.verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as verified_at,
         ct.do_not_contact, co.owner_name, ct.name_source,
         lt.campaign_name as last_campaign, lt.event_type as last_event,
         to_char(lt.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_event_at,
         co.id as lead_id, ct.id as contact_id,
         to_char(greatest(ct.updated_at, co.updated_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
    from lp.contacts ct
    join lp.companies co on co.id = ct.company_id
    left join lateral (
      select t.campaign_name, t.event_type, t.occurred_at from lp.campaign_touches t
       where t.contact_id = ct.id order by t.occurred_at desc, t.id desc limit 1
    ) lt on true
   where ct.email_norm is not null and ct.merged_into is null and co.merged_into is null and ct.id > $1
   order by ct.id
   limit $2`

/** Stable order (contact id), paged so 25k+ rows never sit in one result. */
export async function* exportRows(q: Queryable, pageSize = 5000): AsyncGenerator<ExportRow[]> {
  let after = 0
  while (true) {
    const { rows } = await q.query<Record<string, unknown>>(SQL, [after, pageSize])
    if (rows.length === 0) return
    yield rows.map(toExportRow)
    after = Number(rows[rows.length - 1].contact_id)
    if (rows.length < pageSize) return
  }
}

export function toExportRow(r: Record<string, unknown>): ExportRow {
  const out = {} as ExportRow
  for (const c of EXPORT_COLUMNS) {
    const v = r[c]
    out[c] = v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)
  }
  return out
}

/** RFC 4180 field; also defuses spreadsheet formulas (=, +, -, @ at the start). */
export function csvField(v: string): string {
  let s = v
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function csvLine(values: string[]): string {
  return values.map(csvField).join(',')
}

/** The copy has one row per email address, so `rows` counts emails; `leads` counts the distinct leads (companies) behind them. */
export async function exportCsv(q: Queryable): Promise<{ csv: string; rows: number; leads: number }> {
  const lines = [csvLine([...EXPORT_COLUMNS])]
  let n = 0
  const leads = new Set<string>()
  for await (const page of exportRows(q)) {
    for (const r of page) {
      lines.push(csvLine(EXPORT_COLUMNS.map((c) => r[c])))
      leads.add(r.lead_id)
    }
    n += page.length
  }
  return { csv: lines.join('\r\n') + '\r\n', rows: n, leads: leads.size }
}

/**
 * What a copy written right now would hold: email rows and the leads behind them, counted live
 * with the export's own filter. The Reports screen shows this beside past runs, so a run's
 * row count (emails, frozen on the day it was written) is never read as today's lead count.
 */
export async function liveExportCounts(q: Queryable): Promise<{ emails: number; leads: number }> {
  const { rows } = await q.query<{ emails: number; leads: number }>(
    `select count(*)::int as emails, count(distinct co.id)::int as leads
       from lp.contacts ct join lp.companies co on co.id = ct.company_id
      where ct.email_norm is not null and ct.merged_into is null and co.merged_into is null`,
  )
  return { emails: Number(rows[0]?.emails ?? 0), leads: Number(rows[0]?.leads ?? 0) }
}

// ---------------------------------------------------------------- runs log

export async function startExport(q: Queryable, actor: string, target: 'csv' | 'sheet', destination: string): Promise<number> {
  const { rows } = await q.query<{ id: number }>(
    `insert into lp.exports (target, destination, created_by) values ($1, $2, $3) returning id`,
    [target, destination, actor],
  )
  return rows[0].id
}

export async function finishExport(q: Queryable, id: number, rowCount: number | null, error: string | null): Promise<void> {
  await q.query(`update lp.exports set status = $2, row_count = $3, error = $4, finished_at = now() where id = $1`, [
    id,
    error ? 'failed' : 'done',
    rowCount,
    error ? error.slice(0, 1000) : null,
  ])
}

export interface ExportRun {
  id: number
  target: 'csv' | 'sheet'
  destination: string | null
  row_count: number | null
  status: string
  error: string | null
  created_by: string | null
  started_at: string
  finished_at: string | null
}

export async function recentExports(q: Queryable, limit = 5): Promise<ExportRun[]> {
  const { rows } = await q.query<ExportRun>('select * from lp.exports order by id desc limit $1', [limit])
  return rows
}
