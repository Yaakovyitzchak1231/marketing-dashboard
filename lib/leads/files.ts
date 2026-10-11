/**
 * File links on a lead (plan 2.10's full lead profile): lp.files (migration
 * 0034) stores a link, a name and an optional note against a company (and
 * optionally one of its contacts) -- no paid storage, just the URL. Every
 * add/remove is audited in the universal log (lp.status_history, entity_type
 * 'file').
 */
import type { Db, Queryable } from '../db/types'

export class FilesError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export interface LeadFileRow {
  id: number
  company_id: number
  contact_id: number | null
  name: string
  url: string
  note: string | null
  uploaded_by: string | null
  uploaded_by_name: string | null
  created_at: string
}

/** True when the error is Postgres' "relation ... does not exist" -- the table hasn't migrated on this DB yet. */
export function isMissingTable(e: unknown): boolean {
  const msg = (e as Error)?.message ?? ''
  return /relation .* does not exist/i.test(msg) || /does not exist/i.test(msg)
}

const COLS = `f.id, f.company_id, f.contact_id, f.name, f.url, f.note, f.uploaded_by, a.display_name as uploaded_by_name, f.created_at::text as created_at`

/** A company's attached file links, newest first. Returns [] (not an error) when lp.files hasn't migrated yet. */
export async function listLeadFiles(q: Queryable, companyId: number): Promise<LeadFileRow[]> {
  try {
    const { rows } = await q.query<LeadFileRow>(
      `select ${COLS} from lp.files f left join lp.actors a on a.id = f.uploaded_by
        where f.company_id = $1 order by f.created_at desc, f.id desc`,
      [companyId],
    )
    return rows
  } catch (e) {
    if (isMissingTable(e)) return []
    throw e
  }
}

export interface AddFileInput {
  company_id: number
  contact_id?: number | null
  name: string
  url: string
  note?: string | null
}

function validUrl(u: string): boolean {
  try {
    const parsed = new URL(u)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export async function addLeadFile(db: Db, actor: string, input: AddFileInput): Promise<LeadFileRow> {
  const name = String(input.name ?? '').trim()
  if (!name) throw new FilesError('name is required.')
  if (name.length > 200) throw new FilesError('name is too long (max 200 characters).')
  const url = String(input.url ?? '').trim()
  if (!url || !validUrl(url)) throw new FilesError('url must be a full http(s) link (this stores a link, not an upload).')
  const note = input.note == null || input.note === '' ? null : String(input.note).trim().slice(0, 1000)
  return db.tx(async (tq) => {
    const { rows } = await tq.query<{ id: number }>(
      `insert into lp.files (company_id, contact_id, name, url, note, uploaded_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [input.company_id, input.contact_id ?? null, name, url, note, actor],
    )
    const id = rows[0].id
    await tq.query(
      `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via, note)
       values ('file', $1, 'added', null, $2, $3, 'ops_api', $4)`,
      [id, name, actor, `on company ${input.company_id}`],
    )
    const { rows: out } = await tq.query<LeadFileRow>(
      `select ${COLS} from lp.files f left join lp.actors a on a.id = f.uploaded_by where f.id = $1`,
      [id],
    )
    return out[0]
  }, actor)
}

export async function removeLeadFile(db: Db, actor: string, id: number): Promise<{ removed: boolean }> {
  return db.tx(async (tq) => {
    const { rows } = await tq.query<{ id: number; company_id: number; name: string }>(
      `select id, company_id, name from lp.files where id = $1`,
      [id],
    )
    const row = rows[0]
    if (!row) return { removed: false }
    await tq.query(`delete from lp.files where id = $1`, [id])
    await tq.query(
      `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via, note)
       values ('file', $1, 'removed', $2, null, $3, 'ops_api', $4)`,
      [id, row.name, actor, `on company ${row.company_id}`],
    )
    return { removed: true }
  }, actor)
}
