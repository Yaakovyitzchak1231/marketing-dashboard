/**
 * Write one ResearchResult into the lead hub, the same way for every runner
 * (the built-in engine, Tab, Hermes, a Claude session).
 *
 * Rules:
 * - Evidence or nothing: every email/person/phone/fact row carries the page it
 *   came from (enrichment.evidence_url) and a sources row names the run.
 * - Dedupe on the normalize.ts keys: an address already in Leads is never
 *   inserted twice (contacts.email_norm is unique); if it belongs to another
 *   company it stays there and is counted, not moved.
 * - Never overwrite a value a person (or an earlier source) already set:
 *   names, owner_name and phone are only filled when empty.
 * - One plain-English event per result.
 *
 * Relative imports only: the engine CLI (compiled outside Next) imports this file.
 */
import type { Db, Queryable } from '../db/types.ts'
import { isRoleAddress, normalizeDomain, normalizeEmail, normalizePhone } from '../leads/normalize.ts'
import { logEvent } from '../ops/events.ts'
import { assertTaskClaim, requireRunnableActor } from '../ops/core.ts'
import type { ResearchResult } from './types.ts'

export interface ApplySummary {
  company_id: number
  contacts_created: number
  contacts_existing: number
  contacts_other_company: number
  enrichment_added: number
  owner_set: string | null
  phone_set: string | null
  research_status: 'researched' | 'failed'
  event_id: number
}

export interface ApplyOpts {
  task_id?: number | null
  claim_attempt?: number
  /** sources.kind for the rows this writes; default 'research'. */
  source_kind?: string
  /** sources.source_ref; default '<runner>:<task_id or date>'. */
  source_ref?: string
}

const OWNER_ROLES = /owner|founder|proprietor|president|ceo|principal/i
const RANK = { high: 3, medium: 2, low: 1 } as const

function splitName(n: string): { first: string; last: string | null } {
  const parts = n.trim().split(/\s+/)
  return { first: parts[0], last: parts.length > 1 ? parts.slice(1).join(' ') : null }
}

async function addEnrichment(
  q: Queryable,
  row: { company_id: number; contact_id?: number | null; field: string; value: string; confidence?: string | null; evidence_url?: string | null; method: string; actor: string; task_id?: number | null },
): Promise<boolean> {
  const r = await q.query(
    `insert into lp.enrichment (company_id, contact_id, field, value, confidence, evidence_url, method, actor_id, task_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (company_id, field, lower(value)) do update set last_checked_at = now(), last_checked_by = excluded.actor_id
     returning id, (xmax = 0) as inserted`,
    [row.company_id, row.contact_id ?? null, row.field, row.value.slice(0, 2000), row.confidence ?? null, row.evidence_url ?? null, row.method, row.actor, row.task_id ?? null],
  )
  // A fact found again is re-confirmed (last_checked_at), not added twice.
  return Boolean((r.rows[0] as { inserted?: boolean } | undefined)?.inserted)
}

async function addSource(q: Queryable, company_id: number, contact_id: number | null, kind: string, ref: string, url: string | null, payload: unknown) {
  await q.query(
    `insert into lp.sources (company_id, contact_id, kind, source_ref, url, payload)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (coalesce(company_id, 0), coalesce(contact_id, 0), kind, source_ref) do nothing`,
    [company_id, contact_id, kind, ref, url, payload === undefined ? null : JSON.stringify(payload)],
  )
}

export async function applyResearchResult(db: Db, result: ResearchResult, actor: string, opts: ApplyOpts = {}): Promise<ApplySummary> {
  return db.tx(async (q) => {
    await requireRunnableActor(q, actor)
    // Task-driven callers pass a fenced Db / completion transaction. Standalone
    // imports have no claim; an explicitly supplied attempt is checked here too.
    if (opts.task_id && opts.claim_attempt !== undefined) await assertTaskClaim(q, actor, opts.task_id, opts.claim_attempt)
    const co = await q.query<{ id: number; name: string; website_domain: string | null; owner_name: string | null; phone_e164: string | null; stage: string }>(
      'select id, name, website_domain, owner_name, phone_e164, stage from lp.companies where id = $1 for update',
      [result.company_id],
    )
    if (!co.rows.length) throw new Error(`company ${result.company_id} not found`)
    const company = co.rows[0]
    const kind = opts.source_kind ?? 'research'
    const ref = opts.source_ref ?? `${result.runner}:${opts.task_id ?? new Date().toISOString().slice(0, 10)}`
    const method = result.runner === 'regex' || result.runner === 'engine' ? 'regex' : result.runner === 'llm' ? 'llm' : 'agent'
    const s: ApplySummary = {
      company_id: company.id, contacts_created: 0, contacts_existing: 0, contacts_other_company: 0, enrichment_added: 0,
      owner_set: null, phone_set: null, research_status: 'researched', event_id: 0,
    }
    await addSource(q, company.id, null, kind, ref, result.pages_fetched.find((p) => p.status && p.status < 400)?.url ?? null, {
      runner: result.runner,
      pages: result.pages_fetched.length,
      summary: result.summary,
    })

    // Best owner: highest confidence person with an owner-ish role.
    const owners = result.people
      .filter((p) => p.name && (!p.role || OWNER_ROLES.test(p.role)))
      .sort((a, b) => RANK[b.confidence] - RANK[a.confidence])
    const owner = owners[0] ?? null

    for (const p of result.people) {
      if (!p.name?.trim() || !p.evidence_url) continue
      if (await addEnrichment(q, { company_id: company.id, field: p.role && OWNER_ROLES.test(p.role) ? 'owner_name' : 'person', value: p.role && !OWNER_ROLES.test(p.role) ? `${p.name} (${p.role})` : p.name, confidence: p.confidence, evidence_url: p.evidence_url, method, actor, task_id: opts.task_id })) s.enrichment_added++
    }
    if (owner && !company.owner_name && owner.confidence !== 'low') {
      await q.query('update lp.companies set owner_name = $2 where id = $1 and owner_name is null', [company.id, owner.name])
      s.owner_set = owner.name
    }

    for (const e of result.emails) {
      const norm = normalizeEmail(e.email)
      if (!norm || !e.evidence_url) continue
      const dom = norm.split('@')[1]
      const onSite = company.website_domain ? dom === company.website_domain || dom.endsWith('.' + company.website_domain) : false
      const evidenceDomain = normalizeDomain(e.evidence_url)
      const source = e.how === 'agent' || e.how === 'llm' ? 'research' : evidenceDomain && company.website_domain && evidenceDomain.endsWith(company.website_domain) ? 'website' : 'research'
      // Name for this address: given by the runner, or the owner when the local part starts with the owner's first name.
      let first = e.first_name ?? null
      let last = e.last_name ?? null
      let nameSource: string | null = first ? e.how : null
      let nameConf: string | null = first ? 'medium' : null
      if (!first && owner) {
        const sp = splitName(owner.name)
        const local = norm.split('@')[0]
        if (local.startsWith(sp.first.toLowerCase()) && sp.first.length >= 3) {
          first = sp.first
          last = sp.last
          nameSource = `owner:${owner.how}`
          nameConf = owner.confidence
        }
      }
      const guessed = e.guessed === true
      const ins = await q.query<{ id: number }>(
        `insert into lp.contacts (company_id, email, email_norm, first_name, last_name, title, is_role_address, email_source, name_source, name_confidence, name_evidence_url, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (email_norm) where email_norm is not null and merged_into is null do nothing returning id`,
        [company.id, e.email.trim(), norm, first, last, e.title ?? null, isRoleAddress(norm), guessed ? 'guessed' : e.how === 'facebook' ? 'facebook' : source, nameSource, nameConf, first ? (owner?.evidence_url ?? e.evidence_url) : null, guessed ? 'guessed-hold' : 'new'],
      )
      let contactId: number
      if (ins.rows.length) {
        contactId = ins.rows[0].id
        s.contacts_created++
      } else {
        const ex = await q.query<{ id: number; company_id: number | null; first_name: string | null }>(
          'select id, company_id, first_name from lp.contacts where email_norm = $1',
          [norm],
        )
        contactId = ex.rows[0].id
        if (ex.rows[0].company_id != null && ex.rows[0].company_id !== company.id) {
          s.contacts_other_company++
          continue
        }
        s.contacts_existing++
        if (ex.rows[0].company_id == null) await q.query('update lp.contacts set company_id = $2 where id = $1 and company_id is null', [contactId, company.id])
        if (first && !ex.rows[0].first_name) {
          await q.query(
            `update lp.contacts set first_name = $2, last_name = coalesce(last_name, $3), name_source = coalesce(name_source, $4),
               name_confidence = coalesce(name_confidence, $5) where id = $1 and first_name is null`,
            [contactId, first, last, nameSource, nameConf],
          )
        }
      }
      await addSource(q, company.id, contactId, kind, ref, e.evidence_url, { how: e.how, on_site: onSite, ...(guessed ? { guessed: true } : {}) })
      if (await addEnrichment(q, { company_id: company.id, contact_id: contactId, field: guessed ? 'email_guess' : 'email', value: norm, confidence: onSite && !guessed ? 'high' : 'medium', evidence_url: e.evidence_url, method, actor, task_id: opts.task_id })) s.enrichment_added++
    }

    for (const ph of result.phones) {
      const e164 = normalizePhone(ph.phone)
      if (!e164 || !ph.evidence_url) continue
      if (await addEnrichment(q, { company_id: company.id, field: 'phone', value: e164, confidence: 'high', evidence_url: ph.evidence_url, method, actor, task_id: opts.task_id })) s.enrichment_added++
      if (!company.phone_e164 && !s.phone_set) {
        const taken = await q.query('select 1 from lp.companies where phone_e164 = $1 and id <> $2', [e164, company.id])
        if (!taken.rows.length) {
          await q.query('update lp.companies set phone = coalesce(phone, $2), phone_e164 = $3 where id = $1 and phone_e164 is null', [company.id, ph.phone, e164])
          s.phone_set = e164
        }
      }
    }

    for (const f of result.facts) {
      if (!f.field || !f.value) continue
      if (await addEnrichment(q, { company_id: company.id, field: f.field, value: f.value, confidence: f.confidence, evidence_url: f.evidence_url, method, actor, task_id: opts.task_id })) s.enrichment_added++
    }

    const anyPage = result.pages_fetched.some((p) => p.status != null && p.status < 400)
    // Facts alone (an MX record, a tech hint) don't make a company researched; a page read or a contact found does.
    const foundAnything = result.emails.length + result.people.length + result.phones.length > 0
    s.research_status = anyPage || foundAnything ? 'researched' : 'failed'
    await q.query(
      `update lp.companies set research_status = $2, last_researched_at = now(),
         stage = case when stage = 'new' and $3 then 'researched' else stage end
       where id = $1`,
      [company.id, s.research_status, s.contacts_created + s.contacts_existing > 0],
    )

    const bits: string[] = []
    bits.push(`${s.contacts_created} new email${s.contacts_created === 1 ? '' : 's'}`)
    if (s.contacts_existing) bits.push(`${s.contacts_existing} already on file`)
    if (s.contacts_other_company) bits.push(`${s.contacts_other_company} belong to another company`)
    if (owner) bits.push(`owner ${owner.name} (${owner.confidence})`)
    if (s.research_status === 'failed') bits.push('site unreachable, nothing found')
    s.event_id = await logEvent(q, {
      actor,
      kind: 'research.applied',
      summary: `Researched ${company.name}: ${bits.join(', ')}`,
      entity_type: 'company',
      entity_id: company.id,
      task_id: opts.task_id ?? null,
      data: { runner: result.runner, ...s, event_id: undefined },
    })
    return s
  }, actor)
}
