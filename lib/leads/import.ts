/**
 * Lead Master (Google Sheet) -> lp.* import. Idempotent: running it twice
 * changes nothing the second time. The Sheet is never written to.
 *
 * Columns read (Leads tab, A-U): email, status, first_name, suggested_first_name,
 * last_name, company_name, website, phone, city, state, vertical, batches,
 * email_source, name_source, name_confidence, name_evidence_url, mv_result,
 * mv_date, campaign, sent_date, notes; and when present: personalization,
 * alt_owner_email, alt_owner_name, tech_all, payments, pos.
 *
 * Merge rules:
 *  - A company is matched by website domain, then phone, then name+city+state.
 *    Matching fills empty fields only; it never overwrites a value already in the DB.
 *  - A contact is matched by email. New contacts take the Sheet's status; existing
 *    contacts keep the DB's status (after the move, the DB is the source of truth).
 *    To deliberately catch the DB up with Sheet status changes, see sync-status.ts
 *    (POST /api/ops/import/lead-master?mode=sync_status).
 *  - mv_result becomes a verification_results row (provider 'sheet_import') once.
 *  - campaign becomes one campaign_touches row (source 'sheet_import') once.
 *
 * Imports are relative with .ts extensions so the CLI runs under plain
 * `node --experimental-strip-types` (no build step, no path aliases).
 */
import type { Db, Queryable } from '../db/types.ts'
import { isRoleAddress, nameAddressKey, normalizeDomain, normalizeEmail, normalizePhone } from './normalize.ts'

export const CONTACT_STATUSES = new Set([
  'new', 'verifying', 'valid-ready', 'catch-all-hold', 'guessed-hold', 'role-based-hold', 'needs-check',
  'rejected', 'in-Instantly', 'sent', 'replied', 'bounced', 'do-not-contact',
])

/** The Sheet's status word as the database spells it ("needs check" -> "needs-check"), or null if unknown. */
export function sheetStatus(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().replace(/\s+/g, '-')
  if (!s) return null
  if (CONTACT_STATUSES.has(s)) return s
  const lower = s.toLowerCase()
  for (const known of CONTACT_STATUSES) if (known.toLowerCase() === lower) return known
  return null
}

/** Company stage implied by a contact's Sheet status. */
const STAGE_FOR_STATUS: Record<string, string> = {
  new: 'researched',
  verifying: 'researched',
  'guessed-hold': 'researched',
  'catch-all-hold': 'researched',
  'role-based-hold': 'researched',
  'needs-check': 'researched',
  rejected: 'new',
  'valid-ready': 'ready',
  'in-Instantly': 'in_campaign',
  sent: 'contacted',
  bounced: 'contacted',
  replied: 'replied',
  'do-not-contact': 'do_not_contact',
}
const STAGE_ORDER = ['new', 'researched', 'ready', 'in_campaign', 'contacted', 'replied', 'interested', 'meeting', 'won', 'lost', 'do_not_contact']

const MV_VERDICT: Record<string, string> = {
  ok: 'valid',
  valid: 'valid',
  catch_all: 'catch_all',
  'catch-all': 'catch_all',
  unknown: 'unknown',
  invalid: 'invalid',
  disposable: 'invalid',
  error: 'unknown',
}

export interface ImportStats {
  rows: number
  skipped_no_email: number
  skipped_bad_email: number
  companies_created: number
  companies_matched: number
  contacts_created: number
  contacts_existing: number
  verifications_added: number
  touches_added: number
  enrichment_added: number
}

function clean(v: string | undefined): string | null {
  const s = (v ?? '').trim()
  return s ? s : null
}

/** A heuristic for this sheet's own historical vertical text; not a list of valid pools (any lp.pools slug is). */
function segmentFor(vertical: string | null): string {
  const v = (vertical ?? '').toLowerCase()
  if (/builder/.test(v)) return 'ai_builder'
  if (/\bai\b|agency|automation/.test(v)) return 'ai_agency'
  return 'jeweler'
}

/** "Oct 5, 3:51 PM" (no year in the Sheet) -> a Date in `year`, Eastern time. */
export function parseSheetDate(raw: string | null, year = new Date().getUTCFullYear()): Date | null {
  if (!raw) return null
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2}),?\s*(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(raw.trim())
  if (!m) {
    const t = Date.parse(raw)
    return Number.isNaN(t) ? null : new Date(t)
  }
  const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase())
  if (mon < 0) return null
  let h = Number(m[3]) % 12
  if (m[5].toUpperCase() === 'PM') h += 12
  // Eastern daylight time (UTC-4) covers the Sheet's working months; good to the hour.
  return new Date(Date.UTC(year, mon, Number(m[2]), h + 4, Number(m[4])))
}

interface Keys {
  domain: Map<string, number>
  phone: Map<string, number>
  nameaddr: Map<string, number>
}

async function loadKeys(q: Queryable): Promise<Keys> {
  const { rows } = await q.query<{ id: number; website_domain: string | null; phone_e164: string | null; name_addr_key: string | null }>(
    'select id, website_domain, phone_e164, name_addr_key from lp.companies',
  )
  const k: Keys = { domain: new Map(), phone: new Map(), nameaddr: new Map() }
  for (const r of rows) {
    if (r.website_domain) k.domain.set(r.website_domain, r.id)
    if (r.phone_e164) k.phone.set(r.phone_e164, r.id)
    if (r.name_addr_key) k.nameaddr.set(r.name_addr_key, r.id)
  }
  return k
}

async function upsertCompany(q: Queryable, keys: Keys, row: Record<string, string>, actor: string, stats: ImportStats): Promise<number | null> {
  const name = clean(row.company_name)
  const domain = normalizeDomain(row.website)
  const phone = normalizePhone(row.phone)
  const city = clean(row.city)
  const state = clean(row.state)?.toUpperCase() ?? null
  const nak = nameAddressKey(name, null, city, state)
  const existing = (domain && keys.domain.get(domain)) || (phone && keys.phone.get(phone)) || (nak && keys.nameaddr.get(nak)) || null
  const vertical = clean(row.vertical)
  if (existing) {
    stats.companies_matched++
    // Fill blanks only. A key another company already owns is left alone.
    await q.query(
      `update lp.companies set
         website = coalesce(website, $2),
         website_domain = coalesce(website_domain, case when $3::text is null or exists (select 1 from lp.companies o where o.website_domain = $3 and o.id <> $1) then null else $3 end),
         phone = coalesce(phone, $4),
         phone_e164 = coalesce(phone_e164, case when $5::text is null or exists (select 1 from lp.companies o where o.phone_e164 = $5 and o.id <> $1) then null else $5 end),
         city = coalesce(city, $6), state = coalesce(state, $7), vertical = coalesce(vertical, $8)
       where id = $1`,
      [existing, clean(row.website), domain, clean(row.phone), phone, city, state, vertical],
    )
    if (domain && !keys.domain.has(domain)) keys.domain.set(domain, existing)
    if (phone && !keys.phone.has(phone)) keys.phone.set(phone, existing)
    return existing
  }
  if (!name && !domain) return null
  const { rows } = await q.query<{ id: number }>(
    `insert into lp.companies (name, segment, vertical, website, website_domain, phone, phone_e164, city, state, name_addr_key, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [name ?? domain, segmentFor(vertical), vertical, clean(row.website), domain, clean(row.phone), phone, city, state, nak, actor],
  )
  const id = rows[0].id
  stats.companies_created++
  if (domain) keys.domain.set(domain, id)
  if (phone) keys.phone.set(phone, id)
  if (nak) keys.nameaddr.set(nak, id)
  return id
}

async function addEnrichment(q: Queryable, companyId: number, contactId: number | null, field: string, value: string | null, extra: { confidence?: string | null; evidence_url?: string | null }, actor: string, stats: ImportStats) {
  if (!value) return
  const conf = extra.confidence && ['high', 'medium', 'low'].includes(extra.confidence.toLowerCase()) ? extra.confidence.toLowerCase() : extra.confidence?.toLowerCase().startsWith('med') ? 'medium' : null
  const r = await q.query(
    `insert into lp.enrichment (company_id, contact_id, field, value, confidence, evidence_url, method, actor_id)
     values ($1, $2, $3, $4, $5, $6, 'sheet_import', $7)
     on conflict (company_id, field, lower(value)) do update set last_checked_at = now(), last_checked_by = excluded.actor_id
     returning id, (xmax = 0) as inserted`,
    [companyId, contactId, field, value.slice(0, 4000), conf, extra.evidence_url ?? null, actor],
  )
  if ((r.rows[0] as { inserted?: boolean } | undefined)?.inserted) stats.enrichment_added++
}

export async function importLeadRows(
  db: Db,
  rows: Record<string, string>[],
  opts: { actor?: string; sourceRef?: string; batchSize?: number; year?: number; onProgress?: (done: number, stats: ImportStats) => void } = {},
): Promise<ImportStats> {
  const actor = opts.actor ?? 'system'
  const sourceRef = opts.sourceRef ?? 'lead_master'
  const stats: ImportStats = {
    rows: rows.length, skipped_no_email: 0, skipped_bad_email: 0, companies_created: 0, companies_matched: 0,
    contacts_created: 0, contacts_existing: 0, verifications_added: 0, touches_added: 0, enrichment_added: 0,
  }
  const keys = await loadKeys(db)
  const size = opts.batchSize ?? 500
  for (let start = 0; start < rows.length; start += size) {
    const batch = rows.slice(start, start + size)
    await db.tx(async (q) => {
      for (const row of batch) {
        const rawEmail = clean(row.email)
        if (!rawEmail) {
          stats.skipped_no_email++
          continue
        }
        const email = normalizeEmail(rawEmail)
        if (!email) {
          stats.skipped_bad_email++
          continue
        }
        const companyId = await upsertCompany(q, keys, row, actor, stats)
        const status = sheetStatus(row.status) ?? 'new'
        const mv = clean(row.mv_result)?.toLowerCase() ?? null
        const verdict = mv ? MV_VERDICT[mv] ?? null : null
        const verifiedAt = verdict ? parseSheetDate(clean(row.mv_date), opts.year) : null
        const ins = await q.query<{ id: number }>(
          `insert into lp.contacts (company_id, email, email_norm, first_name, last_name, suggested_first_name, is_role_address,
              email_source, name_source, name_confidence, name_evidence_url, status, verification_status, verified_at, verified_by, personalization, do_not_contact)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
           on conflict (email_norm) where email_norm is not null do nothing returning id`,
          [
            companyId, rawEmail, email, clean(row.first_name), clean(row.last_name), clean(row.suggested_first_name), isRoleAddress(email),
            clean(row.email_source), clean(row.name_source), clean(row.name_confidence), clean(row.name_evidence_url), status,
            verdict ?? 'unverified', verifiedAt, verdict ? 'sheet_import' : null, clean(row.personalization), status === 'do-not-contact',
          ],
        )
        let contactId: number
        if (ins.rows[0]) {
          contactId = ins.rows[0].id
          stats.contacts_created++
        } else {
          const ex = await q.query<{ id: number }>('select id from lp.contacts where email_norm = $1', [email])
          contactId = ex.rows[0].id
          stats.contacts_existing++
          await q.query(
            `update lp.contacts set company_id = coalesce(company_id, $2), first_name = coalesce(first_name, $3), last_name = coalesce(last_name, $4),
               suggested_first_name = coalesce(suggested_first_name, $5), personalization = coalesce(personalization, $6) where id = $1`,
            [contactId, companyId, clean(row.first_name), clean(row.last_name), clean(row.suggested_first_name), clean(row.personalization)],
          )
        }

        if (mv && verdict) {
          const v = await q.query(
            `insert into lp.verification_results (contact_id, email, provider, result, verdict, checked_at, raw)
             select $1, $2, 'sheet_import', $3, $4, coalesce($5, now()), $6
             where not exists (select 1 from lp.verification_results where contact_id = $1 and provider = 'sheet_import' and result = $3)
             returning id`,
            [contactId, email, mv, verdict, verifiedAt, JSON.stringify({ mv_result: row.mv_result, mv_date: row.mv_date ?? null, source: 'Lead Master (MillionVerifier result)' })],
          )
          if (v.rows.length) stats.verifications_added++
        }

        const campaign = clean(row.campaign)
        if (campaign) {
          const t = await q.query(
            `insert into lp.campaign_touches (contact_id, company_id, email, campaign_name, event_type, occurred_at, source, external_id, payload)
             values ($1, $2, $3, $4, 'email_sent', coalesce($5, now()), 'sheet_import', $6, $7)
             on conflict (source, external_id) where external_id is not null do nothing returning id`,
            [contactId, companyId, email, campaign, parseSheetDate(clean(row.sent_date), opts.year), `${email}|${campaign.toLowerCase()}`, JSON.stringify({ sent_date: row.sent_date ?? null })],
          )
          if (t.rows.length) stats.touches_added++
        }

        if (companyId) {
          await q.query(
            `insert into lp.sources (company_id, contact_id, kind, source_ref, payload) values ($1, $2, 'sheet_import', $3, $4)
             on conflict do nothing`,
            [companyId, contactId, sourceRef, JSON.stringify({ batches: clean(row.batches), email_source: clean(row.email_source), notes: clean(row.notes) })],
          )
          const first = clean(row.first_name) ?? clean(row.suggested_first_name)
          await addEnrichment(q, companyId, contactId, 'owner_first_name', first, { confidence: clean(row.name_confidence), evidence_url: clean(row.name_evidence_url) }, actor, stats)
          await addEnrichment(q, companyId, contactId, 'email', email, { evidence_url: clean(row.email_source) === 'website' ? clean(row.website) : null }, actor, stats)
          await addEnrichment(q, companyId, null, 'alt_owner_email', normalizeEmail(row.alt_owner_email), {}, actor, stats)
          await addEnrichment(q, companyId, null, 'alt_owner_name', clean(row.alt_owner_name), {}, actor, stats)
          await addEnrichment(q, companyId, null, 'tech', clean(row.tech_all), {}, actor, stats)
          await addEnrichment(q, companyId, null, 'payments', clean(row.payments), {}, actor, stats)
          await addEnrichment(q, companyId, null, 'pos', clean(row.pos), {}, actor, stats)
          // Stage: the furthest any of this company's contacts has reached; research done once an email exists.
          const target = STAGE_FOR_STATUS[status] ?? 'researched'
          await q.query(
            `update lp.companies set
               stage = case when array_position($2::text[], $3) > array_position($2::text[], stage) then $3 else stage end,
               research_status = case when research_status in ('needs_research', 'failed') then 'researched' else research_status end,
               owner_name = coalesce(owner_name, case when $4::text is not null and $5::text is not null then $4 || ' ' || $5 end)
             where id = $1`,
            [companyId, STAGE_ORDER, target, clean(row.first_name), clean(row.last_name)],
          )
        }
      }
    }, actor)
    opts.onProgress?.(Math.min(start + size, rows.length), stats)
  }
  return stats
}
