/**
 * File links on a lead (plan 2.10's full lead profile): lp.files (migration
 * 0034) stores a link, a name and an optional note against a company (and
 * optionally one of its contacts) -- no paid storage, just the URL. Every
 * add/remove is audited in the universal log (lp.status_history, entity_type
 * 'file').
 */
import type { Db, Queryable } from '../db/types'
import { isUndefinedTable } from '../db/errors.ts'

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

/**
 * True only when the error is Postgres SQLSTATE 42P01 (undefined_table) -- the
 * table hasn't migrated on this DB yet. A missing column (42703) or function
 * (42883) is a real bug and is NOT matched, so callers rethrow it instead of
 * showing an empty card (review fix, Instinct #86 finding 2). Reused by the
 * profile's milestones, segments, campaigns, score, engagement, files and
 * suppression cards (lib/leads/profile.ts).
 */
export function isMissingTable(e: unknown): boolean {
  return isUndefinedTable(e)
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
  const contactId = input.contact_id ?? null
  return db.tx(async (tq) => {
    // Ownership/existence checks (review fix, Instinct #86 finding 3): a file
    // must hang off a real, live company, and a contact_id must be one of THAT
    // company's live contacts -- not any contact id at all. Merged-away rows
    // (merged_into set, the soft delete from 0026) are refused, matching the
    // rest of the code, which treats them as gone (merge moves their files to
    // the survivor, lib/merge/merge.ts).
    const { rows: co } = await tq.query<{ merged_into: number | null }>(
      `select merged_into from lp.companies where id = $1`,
      [input.company_id],
    )
    if (!co[0]) throw new FilesError(`No lead ${input.company_id}.`, 404)
    if (co[0].merged_into != null) {
      throw new FilesError(`Lead ${input.company_id} was merged into lead ${co[0].merged_into}; add the file there.`, 409)
    }
    if (contactId != null) {
      const { rows: ct } = await tq.query<{ company_id: number; merged_into: number | null }>(
        `select company_id, merged_into from lp.contacts where id = $1`,
        [contactId],
      )
      const c = ct[0]
      if (!c) throw new FilesError(`No contact ${contactId}.`, 404)
      if (Number(c.company_id) !== Number(input.company_id)) {
        throw new FilesError(`Contact ${contactId} does not belong to lead ${input.company_id}.`, 400)
      }
      if (c.merged_into != null) {
        throw new FilesError(`Contact ${contactId} was merged into contact ${c.merged_into}; use that contact instead.`, 409)
      }
    }
    const { rows } = await tq.query<{ id: number }>(
      `insert into lp.files (company_id, contact_id, name, url, note, uploaded_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [input.company_id, contactId, name, url, note, actor],
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
