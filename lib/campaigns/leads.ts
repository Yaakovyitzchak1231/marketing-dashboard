/**
 * A campaign's lead list: add by filter or by hand, remove, per-lead overrides,
 * and the list with each lead's Ready / Parked status from the rules evaluator.
 *
 * Standing rules this module keeps:
 *  - It never changes a lead or a contact's status. Removing a lead from a
 *    campaign only removes it from this list; role-based-hold and needs-check
 *    leads are never rejected or deleted here (or anywhere in the workspace).
 *  - It never talks to Instantly. Only Ready leads ever upload, and that step is
 *    the human-approved Add to Instantly flow, which re-checks with the evaluator.
 */
import type { Queryable } from '../db/types.ts'
import { logEvent } from '../ops/events.ts'
import { emitLeadEvents } from '../events/emit.ts'
import { getCampaign } from './store.ts'
import {
  CampaignError,
  MAX_ADD_BY_FILTER,
  describePick,
  overridesFromLines,
  parseOverrides,
  parseTags,
  pickIsEmpty,
  type Campaign,
  type LeadPick,
} from './types.ts'
import { ruleSetFor, verdictsFor, type RuleSetRef, type Tier, type Verdict } from './evaluator.ts'

type Tx = { tx<T>(fn: (q: Queryable) => Promise<T>, actor?: string): Promise<T> }

/** WHERE over lp.companies co for a LeadPick. Returns the SQL and its params, starting at $start. */
export function pickWhere(p: LeadPick, start = 1): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  const add = (sql: string, v: unknown) => {
    params.push(v)
    parts.push(sql.replace('$?', `$${start + params.length - 1}`))
  }
  if (p.pool) add('co.segment = $?', p.pool)
  if (p.stage) add('co.stage = $?', p.stage)
  if (p.state) add('upper(co.state) = $?', p.state)
  if (p.tag) add('$? = any(co.tags)', p.tag)
  if (p.contact_status) add('exists (select 1 from lp.contacts ct where ct.company_id = co.id and ct.status = $?)', p.contact_status)
  if (p.verification) add('exists (select 1 from lp.contacts ct where ct.company_id = co.id and ct.verification_status = $?)', p.verification)
  if (p.q) {
    params.push(`%${p.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)
    const n = `$${start + params.length - 1}`
    parts.push(
      `(co.name ilike ${n} or co.website_domain ilike ${n} or co.city ilike ${n}
        or exists (select 1 from lp.contacts ct where ct.company_id = co.id and (ct.email ilike ${n} or ct.first_name ilike ${n} or ct.last_name ilike ${n})))`,
    )
  }
  return { sql: parts.length ? parts.join(' and ') : 'true', params }
}

async function mustCampaign(q: Queryable, id: number): Promise<Campaign> {
  const c = await getCampaign(q, id)
  if (!c) throw new CampaignError(`No campaign ${id}.`, 404)
  return c
}

/** How many leads a filter matches, and how many of those are already in the campaign. */
export async function previewPick(q: Queryable, campaignId: number, pick: LeadPick): Promise<{ matching: number; already: number }> {
  const w = pickWhere(pick, 2)
  const { rows } = await q.query<{ matching: number; already: number }>(
    `select count(*)::int as matching,
            count(*) filter (where exists (select 1 from lp.campaign_leads l where l.campaign_id = $1 and l.company_id = co.id))::int as already
       from lp.companies co where ${w.sql}`,
    [campaignId, ...w.params],
  )
  return rows[0] ?? { matching: 0, already: 0 }
}

export interface AddResult {
  added: number
  already: number
  missing: number[]
}

/** Add every lead matching the filter. An empty filter is refused (it would add everything). */
export async function addLeadsByFilter(db: Tx, actor: string, campaignId: number, pick: LeadPick, opts: { allowAll?: boolean } = {}): Promise<AddResult & { matching: number }> {
  if (pickIsEmpty(pick) && !opts.allowAll) throw new CampaignError('Pick at least one filter (pool, stage, status, state, tag or search) — an empty filter would add every lead.')
  return db.tx(async (q) => {
    const c = await mustCampaign(q, campaignId)
    const pv = await previewPick(q, campaignId, pick)
    if (pv.matching - pv.already > MAX_ADD_BY_FILTER) throw new CampaignError(`That filter matches ${pv.matching} leads; add at most ${MAX_ADD_BY_FILTER} at a time.`)
    const w = pickWhere(pick, 3)
    const r = await q.query<{ company_id: number }>(
      `insert into lp.campaign_leads (campaign_id, company_id, added_via, added_by, updated_by)
       select $1, co.id, 'filter', $2, $2 from lp.companies co where ${w.sql}
       on conflict (campaign_id, company_id) do nothing returning company_id`,
      [campaignId, actor, ...w.params],
    )
    const added = r.rows.length
    await logEvent(q, {
      actor,
      kind: 'campaign.leads_added',
      summary: `${actor} added ${added} lead${added === 1 ? '' : 's'} to "${c.name}" by filter (${describePick(pick)}); ${pv.already} were already in it`,
      entity_type: 'campaign',
      entity_id: campaignId,
      data: { via: 'filter', filter: pick, added, already: pv.already, matching: pv.matching },
    })
    if (r.rows.length) {
      await emitLeadEvents(
        q,
        r.rows.map((x) => ({
          type: 'added_to_campaign',
          company_id: Number(x.company_id),
          campaign_id: campaignId,
          source: 'dashboard',
          actor,
          props: { via: 'filter' },
        })),
      )
    }
    return { added, already: pv.already, matching: pv.matching, missing: [] }
  }, actor)
}

/** Add these leads (company ids) by hand. Unknown ids are reported, not fatal. */
export async function addLeadsByIds(db: Tx, actor: string, campaignId: number, ids: number[], via: 'hand' | 'api' = 'hand'): Promise<AddResult> {
  return db.tx(async (q) => {
    const c = await mustCampaign(q, campaignId)
    const found = await q.query<{ id: number }>('select id from lp.companies where id = any($1::bigint[])', [ids])
    const have = new Set(found.rows.map((r) => Number(r.id)))
    const missing = ids.filter((i) => !have.has(i))
    const r = await q.query<{ company_id: number }>(
      `insert into lp.campaign_leads (campaign_id, company_id, added_via, added_by, updated_by)
       select $1, x, $3, $2, $2 from unnest($4::bigint[]) as x
       on conflict (campaign_id, company_id) do nothing returning company_id`,
      [campaignId, actor, via, [...have]],
    )
    const added = r.rows.length
    const already = have.size - added
    if (added || missing.length) {
      await logEvent(q, {
        actor,
        kind: 'campaign.leads_added',
        summary: `${actor} added ${added} lead${added === 1 ? '' : 's'} to "${c.name}" by hand${already ? `; ${already} already in it` : ''}${missing.length ? `; ${missing.length} id${missing.length === 1 ? '' : 's'} not found` : ''}`,
        entity_type: 'campaign',
        entity_id: campaignId,
        data: { via, company_ids: r.rows.map((x) => Number(x.company_id)), already, missing },
      })
    }
    if (r.rows.length) {
      await emitLeadEvents(
        q,
        r.rows.map((x) => ({
          type: 'added_to_campaign',
          company_id: Number(x.company_id),
          campaign_id: campaignId,
          source: 'dashboard',
          actor,
          props: { via },
        })),
      )
    }
    return { added, already, missing }
  }, actor)
}

/**
 * Take leads off this campaign's list. The leads themselves are untouched
 * (statuses, holds, history all stay); the removed rows, overrides included,
 * are kept in the activity log so a removal can be undone by hand.
 */
export async function removeLeads(db: Tx, actor: string, campaignId: number, ids: number[]): Promise<{ removed: number }> {
  return db.tx(async (q) => {
    const c = await mustCampaign(q, campaignId)
    const { rows } = await q.query<{ company_id: number; contact_id: number | null; overrides: Record<string, string>; note: string | null; name: string }>(
      `delete from lp.campaign_leads l using lp.companies co
        where l.campaign_id = $1 and l.company_id = any($2::bigint[]) and co.id = l.company_id
        returning l.company_id, l.contact_id, l.overrides, l.note, co.name`,
      [campaignId, ids],
    )
    if (rows.length) {
      const names = rows.slice(0, 5).map((r) => r.name).join(', ')
      await logEvent(q, {
        actor,
        kind: 'campaign.leads_removed',
        summary: `${actor} removed ${rows.length} lead${rows.length === 1 ? '' : 's'} from "${c.name}" (${names}${rows.length > 5 ? ', …' : ''}). The leads themselves are unchanged.`,
        entity_type: 'campaign',
        entity_id: campaignId,
        data: { removed: rows.map((r) => ({ company_id: Number(r.company_id), contact_id: r.contact_id, overrides: r.overrides, note: r.note })) },
      })
    }
    return { removed: rows.length }
  }, actor)
}

export interface LeadPatch {
  overrides?: Record<string, string>
  /** Merge into the existing overrides instead of replacing them (blank value removes a key). */
  overrides_merge?: Record<string, string | null>
  contact_id?: number | null
  note?: string | null
  tags?: string[]
}

export function parseLeadPatch(body: unknown): LeadPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CampaignError('Send the lead changes as JSON.')
  const b = body as Record<string, unknown>
  const allowed = ['overrides', 'overrides_merge', 'overrides_text', 'contact_id', 'note', 'tags']
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw new CampaignError(`${k} can't be set on a campaign lead. Fields: ${allowed.join(', ')}.`)
  const out: LeadPatch = {}
  if ('overrides' in b) out.overrides = parseOverrides(b.overrides)
  if ('overrides_text' in b) out.overrides = overridesFromLines(String(b.overrides_text ?? ''))
  if ('overrides_merge' in b) {
    const m = b.overrides_merge
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new CampaignError('overrides_merge must be an object.')
    const keep = parseOverrides(m)
    out.overrides_merge = { ...Object.fromEntries(Object.keys(m as object).map((k) => [k.trim(), null])), ...keep }
  }
  if ('contact_id' in b) {
    const v = b.contact_id
    if (v === null || v === '' || v === undefined) out.contact_id = null
    else {
      const n = Number(v)
      if (!Number.isInteger(n) || n <= 0) throw new CampaignError('contact_id must be a contact id, or empty.')
      out.contact_id = n
    }
  }
  if ('note' in b) {
    if (b.note !== null && typeof b.note !== 'string') throw new CampaignError('note must be text.')
    const s = (b.note ?? '').toString().trim()
    if (s.length > 2000) throw new CampaignError('note is too long (max 2000 characters).')
    out.note = s || null
  }
  if ('tags' in b) out.tags = parseTags(b.tags)
  if (!Object.keys(out).length) throw new CampaignError('Nothing to change.')
  return out
}

const showObj = (o: Record<string, string>) => (Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ') : '(none)')

/** Edit one lead in one campaign: overrides, pinned contact, note; tags live on the lead itself. */
export async function updateCampaignLead(db: Tx, actor: string, campaignId: number, companyId: number, p: LeadPatch) {
  return db.tx(async (q) => {
    const c = await mustCampaign(q, campaignId)
    const cur = await q.query<{ contact_id: number | null; overrides: Record<string, string>; note: string | null; name: string; tags: string[] }>(
      `select l.contact_id, l.overrides, l.note, co.name, co.tags from lp.campaign_leads l join lp.companies co on co.id = l.company_id
        where l.campaign_id = $1 and l.company_id = $2 for update of l`,
      [campaignId, companyId],
    )
    const old = cur.rows[0]
    if (!old) throw new CampaignError(`Lead ${companyId} is not in this campaign.`, 404)
    const changes: { field: string; from: string | null; to: string | null }[] = []
    let overrides = old.overrides ?? {}
    if (p.overrides !== undefined) overrides = p.overrides
    if (p.overrides_merge) {
      overrides = { ...overrides }
      for (const [k, v] of Object.entries(p.overrides_merge)) {
        if (v === null || v === '') delete overrides[k]
        else overrides[k] = v
      }
    }
    if (JSON.stringify(overrides) !== JSON.stringify(old.overrides ?? {})) changes.push({ field: 'overrides', from: showObj(old.overrides ?? {}), to: showObj(overrides) })
    let contactId = old.contact_id == null ? null : Number(old.contact_id)
    if (p.contact_id !== undefined && p.contact_id !== contactId) {
      if (p.contact_id != null) {
        const ok = await q.query('select 1 from lp.contacts where id = $1 and company_id = $2', [p.contact_id, companyId])
        if (!ok.rows[0]) throw new CampaignError(`Contact ${p.contact_id} doesn't belong to this lead.`)
      }
      changes.push({ field: 'contact', from: contactId == null ? null : String(contactId), to: p.contact_id == null ? null : String(p.contact_id) })
      contactId = p.contact_id
    }
    let note = old.note
    if (p.note !== undefined && p.note !== old.note) {
      changes.push({ field: 'note', from: old.note, to: p.note })
      note = p.note
    }
    let tagDiff: { added: string[]; removed: string[] } | null = null
    if (p.tags !== undefined && JSON.stringify([...p.tags].sort()) !== JSON.stringify([...(old.tags ?? [])].sort())) {
      changes.push({ field: 'tags', from: (old.tags ?? []).join(', ') || null, to: p.tags.join(', ') || null })
      await q.query('update lp.companies set tags = $2 where id = $1', [companyId, p.tags])
      const before = new Set(old.tags ?? [])
      const after = new Set(p.tags)
      tagDiff = { added: p.tags.filter((t) => !before.has(t)), removed: (old.tags ?? []).filter((t) => !after.has(t)) }
    }
    if (!changes.length) return { changes }
    await q.query(
      `update lp.campaign_leads set overrides = $3::jsonb, contact_id = $4, note = $5, updated_by = $6 where campaign_id = $1 and company_id = $2`,
      [campaignId, companyId, JSON.stringify(overrides), contactId, note, actor],
    )
    await logEvent(q, {
      actor,
      kind: 'campaign.lead_updated',
      summary: `${actor} changed "${old.name}" in "${c.name}": ${changes.map((x) => `${x.field}: ${x.from ?? '(empty)'} → ${x.to ?? '(empty)'}`).join('; ')}`.slice(0, 2000),
      entity_type: 'campaign',
      entity_id: campaignId,
      data: { company_id: companyId, changes },
    })
    if (tagDiff && (tagDiff.added.length || tagDiff.removed.length)) {
      await emitLeadEvents(q, [
        ...tagDiff.added.map((tag) => ({ type: 'tag_added', company_id: companyId, campaign_id: campaignId, source: 'dashboard', actor, props: { tag } })),
        ...tagDiff.removed.map((tag) => ({ type: 'tag_removed', company_id: companyId, campaign_id: campaignId, source: 'dashboard', actor, props: { tag } })),
      ])
    }
    return { changes }
  }, actor)
}

export const LEAD_PAGE_SIZE = 100

export interface CampaignLeadRow {
  company_id: number
  name: string
  segment: string
  stage: string
  city: string | null
  state: string | null
  website_domain: string | null
  tags: string[]
  contact_id: number | null
  overrides: Record<string, string>
  note: string | null
  added_via: string
  added_by: string | null
  added_at: Date
  contacts: { id: number; email: string | null; status: string; verification_status: string; first_name: string | null; is_role_address: boolean | null }[]
  verdict: Verdict | null
}

export interface LeadListFilter {
  q?: string | null
  state?: string | null
  tier?: Tier | 'not_scored' | null
  page?: number
}

export async function listCampaignLeads(
  q: Queryable,
  campaignId: number,
  f: LeadListFilter = {},
): Promise<{ campaign: Campaign; ruleSet: RuleSetRef | null; rows: CampaignLeadRow[]; total: number; page: number; pages: number }> {
  const c = await mustCampaign(q, campaignId)
  const page = Math.max(1, Math.trunc(Number(f.page) || 1))
  const params: unknown[] = [campaignId]
  const where: string[] = ['l.campaign_id = $1']
  if (f.q) {
    params.push(`%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)
    const n = `$${params.length}`
    where.push(`(co.name ilike ${n} or co.website_domain ilike ${n} or exists (select 1 from lp.contacts ct where ct.company_id = co.id and ct.email ilike ${n}))`)
  }
  if (f.state) {
    params.push(f.state.toUpperCase())
    where.push(`upper(co.state) = $${params.length}`)
  }
  // Tier filter: stored scores (PR 1's lp.lead_evaluations). Ignored before 0010 exists.
  let ruleSet: RuleSetRef | null = null
  if (f.tier) {
    ruleSet = await ruleSetFor(q, c)
    if (ruleSet) {
      params.push(ruleSet.id)
      const rs = `$${params.length}`
      if (f.tier === 'not_scored') where.push(`not exists (select 1 from lp.lead_evaluations e where e.rule_set_id = ${rs} and e.company_id = l.company_id)`)
      else {
        params.push(f.tier)
        where.push(`exists (select 1 from lp.lead_evaluations e where e.rule_set_id = ${rs} and e.company_id = l.company_id and e.tier = $${params.length})`)
      }
    }
  }
  const whereSql = where.join(' and ')
  const total = Number((await q.query<{ n: number }>(`select count(*)::int as n from lp.campaign_leads l join lp.companies co on co.id = l.company_id where ${whereSql}`, params)).rows[0]?.n ?? 0)
  const pages = Math.max(1, Math.ceil(total / LEAD_PAGE_SIZE))
  const { rows } = await q.query<Omit<CampaignLeadRow, 'verdict'>>(
    `select co.id as company_id, co.name, co.segment, co.stage, co.city, co.state, co.website_domain, co.tags,
            l.contact_id, l.overrides, l.note, l.added_via, l.added_by, l.added_at,
            coalesce((select json_agg(json_build_object('id', ct.id, 'email', ct.email, 'status', ct.status,
                       'verification_status', ct.verification_status, 'first_name', ct.first_name, 'is_role_address', ct.is_role_address) order by ct.id)
                       from lp.contacts ct where ct.company_id = co.id), '[]'::json) as contacts
       from lp.campaign_leads l join lp.companies co on co.id = l.company_id
      where ${whereSql}
      order by l.added_at desc, co.id desc
      limit ${LEAD_PAGE_SIZE} offset ${(Math.min(page, pages) - 1) * LEAD_PAGE_SIZE}`,
    params,
  )
  const ids = rows.map((r) => Number(r.company_id))
  const v = await verdictsFor(q, c, ids)
  return {
    campaign: c,
    ruleSet: v.ruleSet ?? ruleSet,
    total,
    page: Math.min(page, pages),
    pages,
    rows: rows.map((r) => ({
      ...r,
      company_id: Number(r.company_id),
      contact_id: r.contact_id == null ? null : Number(r.contact_id),
      tags: r.tags ?? [],
      overrides: r.overrides ?? {},
      contacts: (r.contacts ?? []).map((x) => ({ ...x, id: Number(x.id) })),
      verdict: v.verdicts.get(Number(r.company_id)) ?? null,
    })),
  }
}

/** One lead in one campaign, with its status (for worker C's per-lead preview and the API). */
export async function getCampaignLead(q: Queryable, campaignId: number, companyId: number): Promise<CampaignLeadRow | null> {
  const c = await mustCampaign(q, campaignId)
  const { rows } = await q.query<Omit<CampaignLeadRow, 'verdict'>>(
    `select co.id as company_id, co.name, co.segment, co.stage, co.city, co.state, co.website_domain, co.tags,
            l.contact_id, l.overrides, l.note, l.added_via, l.added_by, l.added_at,
            coalesce((select json_agg(json_build_object('id', ct.id, 'email', ct.email, 'status', ct.status,
                       'verification_status', ct.verification_status, 'first_name', ct.first_name, 'is_role_address', ct.is_role_address) order by ct.id)
                       from lp.contacts ct where ct.company_id = co.id), '[]'::json) as contacts
       from lp.campaign_leads l join lp.companies co on co.id = l.company_id
      where l.campaign_id = $1 and l.company_id = $2`,
    [campaignId, companyId],
  )
  const r = rows[0]
  if (!r) return null
  const v = await verdictsFor(q, c, [companyId])
  return {
    ...r,
    company_id: Number(r.company_id),
    contact_id: r.contact_id == null ? null : Number(r.contact_id),
    tags: r.tags ?? [],
    overrides: r.overrides ?? {},
    contacts: (r.contacts ?? []).map((x) => ({ ...x, id: Number(x.id) })),
    verdict: v.verdicts.get(companyId) ?? null,
  }
}
