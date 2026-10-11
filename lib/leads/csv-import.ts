/**
 * CSV import with column mapping, a dry-run preview, and phone-only contacts
 * (plan item 1.13, depends on 1.7's custom fields). One pass over the rows does
 * both the preview and the real import -- a dry run runs for real inside a
 * transaction and rolls it back (lib/leads/import-request.ts does the same for
 * the Lead Master import), so the preview's counts are exactly what a real run
 * would do right now.
 *
 * Target fields a column can map to:
 *   email, first_name, last_name, title, phone            (contact)
 *   company_name, website, company_phone, city, state      (company)
 *   contact_custom.<key>, company_custom.<key>             (lib/fields, plan 1.7)
 * Anything else (or an empty mapping value) is ignored.
 */
import type { Db, Queryable } from '../db/types'
import { nameAddressKey, normalizeDomain, normalizeEmail, normalizePhone } from './normalize'
import { checkEmails } from '../suppressions/store'
import { FieldError, type FieldDefRow, listFieldDefs, validateFieldValue } from '../fields/registry'

export class CsvImportError extends Error {
  status: 400 | 404 = 400
  constructor(message: string) {
    super(message)
  }
}

export type ImportOutcome = 'would_create' | 'would_update' | 'skipped_duplicate' | 'skipped_suppressed' | 'invalid'

export interface ImportRowResult {
  row: number // 1-based within the data rows (row 1 = first row after the header)
  outcome: ImportOutcome
  reason?: string
  email?: string | null
  phone?: string | null
  company?: string | null
  contact_id?: number
  company_id?: number
}

export interface ImportSummary {
  total: number
  would_create: number
  would_update: number
  skipped_duplicate: number
  skipped_suppressed: number
  invalid: number
  rows: ImportRowResult[]
}

export interface ImportOptions {
  mapping: Record<string, string>
  pool?: string | null
  campaign_id?: number | null
  actor: string
  via?: 'ui' | 'ops_api'
  /** Cap on how many per-row results come back in detail; the summary counts are always exact. */
  maxDetailRows?: number
}

const CONTACT_FIELDS = new Set(['email', 'first_name', 'last_name', 'title', 'phone'])
const COMPANY_FIELDS = new Set(['company_name', 'website', 'company_phone', 'city', 'state'])

interface MappedRow {
  contact: Record<string, string>
  company: Record<string, string>
  contactCustom: Record<string, unknown>
  companyCustom: Record<string, unknown>
  customError: string | null
}

function applyMapping(row: Record<string, string>, mapping: Record<string, string>, fieldDefs: Map<string, FieldDefRow>): MappedRow {
  const contact: Record<string, string> = {}
  const company: Record<string, string> = {}
  const contactCustom: Record<string, unknown> = {}
  const companyCustom: Record<string, unknown> = {}
  let customError: string | null = null
  for (const [csvCol, target] of Object.entries(mapping)) {
    if (!target || target === 'skip') continue
    const raw = row[csvCol.trim().toLowerCase()]
    if (raw === undefined || raw === '') continue
    if (CONTACT_FIELDS.has(target)) {
      contact[target] = raw
      continue
    }
    if (COMPANY_FIELDS.has(target)) {
      company[target] = raw
      continue
    }
    const m = /^(contact|company)_custom\.(.+)$/.exec(target)
    if (!m) continue
    const [, entity, key] = m
    const def = fieldDefs.get(`${entity}:${key}`)
    if (!def) {
      customError = customError ?? `"${key}" is not a defined ${entity} field.`
      continue
    }
    try {
      const value = validateFieldValue(def, raw)
      if (value !== null) (entity === 'contact' ? contactCustom : companyCustom)[key] = value
    } catch (e) {
      if (e instanceof FieldError) customError = customError ?? e.message
      else throw e
    }
  }
  return { contact, company, contactCustom, companyCustom, customError }
}

async function findCompany(q: Queryable, domain: string | null, phone: string | null, nameAddr: string | null): Promise<number | null> {
  if (domain) {
    const { rows } = await q.query<{ id: number }>('select id from lp.companies where website_domain = $1 limit 1', [domain])
    if (rows[0]) return rows[0].id
  }
  if (phone) {
    const { rows } = await q.query<{ id: number }>('select id from lp.companies where phone_e164 = $1 limit 1', [phone])
    if (rows[0]) return rows[0].id
  }
  if (nameAddr) {
    const { rows } = await q.query<{ id: number }>('select id from lp.companies where name_addr_key = $1 limit 1', [nameAddr])
    if (rows[0]) return rows[0].id
  }
  return null
}

/**
 * Preview and import, same pass. Always writes (the caller wraps in a rolled-
 * back transaction for a dry run -- see runCsvImport below).
 */
async function processRows(
  db: Db,
  rows: Record<string, string>[],
  opts: ImportOptions,
): Promise<ImportSummary> {
  const fieldDefList = await listFieldDefs(db, { include_archived: false })
  const fieldDefs = new Map(fieldDefList.map((d) => [`${d.entity}:${d.key}`, d]))
  const pool = opts.pool?.trim() || null
  const campaignId = opts.campaign_id ?? null

  const seenEmails = new Set<string>()
  const seenPhones = new Set<string>()
  const results: ImportRowResult[] = []
  const counts: Record<ImportOutcome, number> = { would_create: 0, would_update: 0, skipped_duplicate: 0, skipped_suppressed: 0, invalid: 0 }

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 1
    const mapped = applyMapping(rows[i], opts.mapping, fieldDefs)
    const emailRaw = mapped.contact.email?.trim() || null
    const phoneRaw = mapped.contact.phone?.trim() || null
    const email = emailRaw ? normalizeEmail(emailRaw) : null
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null

    const push = (outcome: ImportOutcome, reason?: string, extra: Partial<ImportRowResult> = {}) => {
      counts[outcome]++
      results.push({ row: rowNum, outcome, reason, email, phone, company: mapped.company.company_name || null, ...extra })
    }

    if (emailRaw && !email) {
      push('invalid', `"${emailRaw}" is not a valid email address.`)
      continue
    }
    if (phoneRaw && !phone) {
      push('invalid', `"${phoneRaw}" doesn't look like a phone number.`)
      continue
    }
    if (!email && !phone) {
      push('invalid', 'No email or phone number.')
      continue
    }
    if (mapped.customError) {
      push('invalid', mapped.customError)
      continue
    }

    if ((email && seenEmails.has(email)) || (!email && phone && seenPhones.has(phone))) {
      push('skipped_duplicate', 'Already in this file.')
      continue
    }
    if (email) seenEmails.add(email)
    if (phone) seenPhones.add(phone)

    if (email) {
      const check = await checkEmails(db, [email], campaignId)
      if (check[email]?.suppressed) {
        push('skipped_suppressed', `Suppressed (${check[email].by?.reason ?? 'on the list'}).`)
        continue
      }
    }

    // Each row's writes run under a savepoint (review fix, #76): a row that still collides
    // with an existing lead on a unique key is rolled back alone and reported in the
    // summary as invalid, instead of failing the whole import.
    await db.query('savepoint csv_row')
    let companyId: number
    let contactId: number
    let willUpdate: boolean
    try {
      // Find or create the contact (and its company) for real -- processRows always writes;
      // the caller rolls this transaction back for a dry run.
      const existing = email
        ? await db.query<{ id: number; company_id: number }>('select id, company_id from lp.contacts where email_norm = $1 limit 1', [email])
        : await db.query<{ id: number; company_id: number }>('select id, company_id from lp.contacts where phone_e164 = $1 and email is null limit 1', [phone])
      willUpdate = Boolean(existing.rows[0])

      const companyName = mapped.company.company_name?.trim() || null
      const domain = normalizeDomain(mapped.company.website)
      const companyPhone = mapped.company.company_phone ? normalizePhone(mapped.company.company_phone) : null
      const nameAddr = companyName ? nameAddressKey(companyName, null, mapped.company.city, mapped.company.state) : null

      if (willUpdate) {
        companyId = existing.rows[0].company_id
      } else {
        // Look up by phone too (review fix, #76): a company-phone-only row used to skip the
        // lookup and insert a duplicate phone, which aborted the whole import on companies_phone_uq.
        const found = companyName || domain || companyPhone ? await findCompany(db, domain, companyPhone, nameAddr) : null
        if (found) {
          companyId = found
        } else {
          const { rows: cRows } = await db.query<{ id: number }>(
            `insert into lp.companies (name, website, website_domain, phone, phone_e164, city, state, name_addr_key, segment, created_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, 'other'), $10) returning id`,
            [companyName ?? '(unknown)', mapped.company.website || null, domain, mapped.company.company_phone || null, companyPhone, mapped.company.city || null, mapped.company.state || null, nameAddr, pool, opts.actor],
          )
          companyId = cRows[0].id
        }
      }
      if (Object.keys(mapped.companyCustom).length) {
        await db.query(`update lp.companies set custom = custom || $2::jsonb where id = $1`, [companyId, JSON.stringify(mapped.companyCustom)])
      }

      if (willUpdate) {
        contactId = existing.rows[0].id
        const sets: string[] = []
        const params: unknown[] = []
        for (const [col, val] of Object.entries({ first_name: mapped.contact.first_name, last_name: mapped.contact.last_name, title: mapped.contact.title })) {
          if (val) {
            params.push(val)
            sets.push(`${col} = $${params.length}`)
          }
        }
        if (phone && !email) {
          params.push(phone)
          sets.push(`phone_e164 = $${params.length}`)
          params.push(phoneRaw)
          sets.push(`phone = $${params.length}`)
        }
        if (sets.length) {
          params.push(contactId)
          await db.query(`update lp.contacts set ${sets.join(', ')} where id = $${params.length}`, params)
        }
      } else {
        const { rows: ctRows } = await db.query<{ id: number }>(
          `insert into lp.contacts (company_id, email, email_norm, first_name, last_name, title, phone, phone_e164, email_source, name_source, status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'import', 'import', 'new') returning id`,
          [companyId, email, email, mapped.contact.first_name || null, mapped.contact.last_name || null, mapped.contact.title || null, phoneRaw, phone],
        )
        contactId = ctRows[0].id
      }
      if (Object.keys(mapped.contactCustom).length) {
        await db.query(`update lp.contacts set custom = custom || $2::jsonb where id = $1`, [contactId, JSON.stringify(mapped.contactCustom)])
      }

      if (campaignId) {
        await db.query(
          `insert into lp.campaign_leads (campaign_id, company_id, added_via, added_by) values ($1, $2, 'api', $3) on conflict (campaign_id, company_id) do nothing`,
          [campaignId, companyId, opts.actor],
        )
      }
      await db.query('release savepoint csv_row')
    } catch (e) {
      if ((e as { code?: string })?.code !== '23505') throw e
      await db.query('rollback to savepoint csv_row')
      push('invalid', 'Conflicts with a lead already saved (same company phone, website or email). Row skipped.')
      continue
    }

    push(willUpdate ? 'would_update' : 'would_create', undefined, { contact_id: contactId, company_id: companyId })
  }

  const maxDetail = opts.maxDetailRows ?? 500
  return {
    total: rows.length,
    would_create: counts.would_create,
    would_update: counts.would_update,
    skipped_duplicate: counts.skipped_duplicate,
    skipped_suppressed: counts.skipped_suppressed,
    invalid: counts.invalid,
    rows: results.slice(0, maxDetail),
  }
}

class DryRunRollback extends Error {}

/**
 * dry_run true: runs the whole import for real inside a transaction and rolls
 * it back, so the counts are exactly what importing right now would do, and
 * nothing is written. dry_run false: imports for real and logs one activity row.
 */
export async function runCsvImport(db: Db, rows: Record<string, string>[], opts: ImportOptions & { dryRun: boolean }): Promise<ImportSummary> {
  if (!rows.length) throw new CsvImportError('No rows to import.')
  if (!opts.dryRun) {
    let summary: ImportSummary | null = null
    await db.tx(async (q) => {
      const inner: Db = { query: (t, p) => q.query(t, p), tx: (fn) => fn(q) }
      summary = await processRows(inner, rows, opts)
    }, opts.actor)
    const s = summary!
    await db.query(
      `insert into lp.events (actor, kind, summary, data) values ($1, 'import.csv', $2, $3)`,
      [opts.actor, `Imported a CSV: ${s.would_create} new, ${s.would_update} updated, ${s.skipped_suppressed} suppressed, ${s.skipped_duplicate} duplicate, ${s.invalid} invalid (of ${s.total} rows)`, JSON.stringify({ would_create: s.would_create, would_update: s.would_update, skipped_duplicate: s.skipped_duplicate, skipped_suppressed: s.skipped_suppressed, invalid: s.invalid })],
    )
    return s
  }
  let result: ImportSummary | null = null
  try {
    await db.tx(async (q) => {
      const inner: Db = { query: (t, p) => q.query(t, p), tx: (fn) => fn(q) }
      result = await processRows(inner, rows, opts)
      throw new DryRunRollback('dry run')
    }, opts.actor)
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e
  }
  if (!result) throw new Error('dry run produced no result')
  return result
}
