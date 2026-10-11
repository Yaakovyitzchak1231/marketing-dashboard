/**
 * Campaigns: create, read, edit, duplicate, archive. The same functions back the
 * dashboard (actor 'owner') and the ops API (the calling agent), so a person and
 * an agent are held to the same checks. Every change writes one activity event
 * naming the actor and each field's old -> new value.
 *
 * Nothing in this module talks to Instantly.
 */
import type { Queryable } from '../db/types.ts'
import { logEvent } from '../ops/events.ts'
import {
  CampaignError,
  FIELD_WORDS,
  POOL_LABELS,
  type Campaign,
  type CampaignField,
  type CampaignPatch,
  type CampaignStatus,
  type CampaignSummary,
} from './types.ts'
import { ruleSetFor, ruleSetScope, rulesWriter } from './evaluator.ts'

type Tx = { tx<T>(fn: (q: Queryable) => Promise<T>, actor?: string): Promise<T> }

const COLS = `c.id, c.name, c.pool, c.goal, c.notes, c.owner, c.status, c.rule_set_id, c.based_on, c.is_template,
  c.created_by, c.updated_by, c.created_at, c.updated_at`

function row(r: Record<string, unknown>): Campaign {
  return {
    ...(r as unknown as Campaign),
    id: Number(r.id),
    rule_set_id: r.rule_set_id == null ? null : Number(r.rule_set_id),
    based_on: r.based_on == null ? null : Number(r.based_on),
  }
}

export async function listStatuses(q: Queryable, opts: { includeInactive?: boolean } = {}): Promise<CampaignStatus[]> {
  const { rows } = await q.query<CampaignStatus>(
    `select id, label, sort, is_archived, active from lp.campaign_statuses
      where $1 or active order by sort, id`,
    [Boolean(opts.includeInactive)],
  )
  return rows
}

export async function getCampaign(q: Queryable, id: number): Promise<Campaign | null> {
  const { rows } = await q.query<Record<string, unknown>>(`select ${COLS} from lp.campaigns c where c.id = $1`, [id])
  return rows[0] ? row(rows[0]) : null
}

export async function listCampaigns(
  q: Queryable,
  opts: { includeArchived?: boolean; pool?: string | null; status?: string | null; templatesOnly?: boolean } = {},
): Promise<CampaignSummary[]> {
  const { rows } = await q.query<Record<string, unknown>>(
    `select ${COLS}, s.label as status_label, s.is_archived as status_archived, a.display_name as owner_name,
            (select count(*) from lp.campaign_leads l where l.campaign_id = c.id)::int as lead_count
       from lp.campaigns c
       join lp.campaign_statuses s on s.id = c.status
       left join lp.actors a on a.id = c.owner
      where ($1 or not s.is_archived or $3::text is not null)
        and ($2::text is null or c.pool = $2)
        and ($3::text is null or c.status = $3)
        and (not $4 or c.is_template)
      order by s.is_archived, c.is_template, c.updated_at desc, c.id desc
      limit 500`,
    [Boolean(opts.includeArchived), opts.pool ?? null, opts.status ?? null, Boolean(opts.templatesOnly)],
  )
  return rows.map((r) => ({ ...row(r), status_label: String(r.status_label), status_archived: Boolean(r.status_archived), owner_name: (r.owner_name as string) ?? null, lead_count: Number(r.lead_count) }))
}

/** Standing rule: an agent may not change which rules or which pool a campaign uses. */
const HUMAN_ONLY: CampaignField[] = ['pool', 'rule_set_id']

async function isHuman(q: Queryable, actor: string): Promise<boolean> {
  const { rows } = await q.query<{ kind: string }>('select kind from lp.actors where id = $1', [actor])
  return rows[0]?.kind === 'human'
}

async function requireHumanFor(q: Queryable, actor: string, fields: CampaignField[]): Promise<void> {
  const hit = fields.filter((f) => HUMAN_ONLY.includes(f))
  if (hit.length && !(await isHuman(q, actor))) {
    throw new CampaignError(
      `Only a person can change a campaign's ${hit.map((f) => FIELD_WORDS[f].toLowerCase()).join(' and ')}. Ask in Needs your OK (or propose a rules change); nothing was changed.`,
      403,
    )
  }
}

async function checkRefs(q: Queryable, p: CampaignPatch, campaignId: number | null = null, currentRuleSet: number | null = null): Promise<void> {
  if (p.status !== undefined) {
    const { rows } = await q.query<{ active: boolean }>('select active from lp.campaign_statuses where id = $1', [p.status])
    if (!rows[0]) {
      const all = await listStatuses(q)
      throw new CampaignError(`"${p.status}" is not a campaign status. Pick one of: ${all.map((s) => s.id).join(', ')}.`)
    }
    if (!rows[0].active) throw new CampaignError(`The status "${p.status}" is switched off.`)
  }
  if (p.owner) {
    const { rows } = await q.query('select 1 from lp.actors where id = $1', [p.owner])
    if (!rows[0]) throw new CampaignError(`No teammate with id "${p.owner}".`)
  }
  if (p.rule_set_id != null) {
    const reg = await q.query<{ t: string | null }>(`select to_regclass('lp.rule_sets')::text as t`)
    if (!reg.rows[0]?.t) throw new CampaignError('Rule sets are not set up yet (the rules update has not been merged). Leave Rules empty to use the pool’s rules.')
    const { rows } = await q.query<{ archived: boolean; scope: string }>('select coalesce(archived, false) as archived, scope from lp.rule_sets where id = $1', [p.rule_set_id])
    if (!rows[0]) throw new CampaignError(`No rule set ${p.rule_set_id}.`)
    if (rows[0].archived) throw new CampaignError(`Rule set ${p.rule_set_id} is archived.`)
    if (rows[0].scope === 'campaign' && p.rule_set_id !== currentRuleSet) {
      const owner = await q.query<{ id: number }>('select id from lp.campaigns where rule_set_id = $1 and ($2::bigint is null or id <> $2) limit 1', [p.rule_set_id, campaignId])
      if (owner.rows[0]) throw new CampaignError(`Rule set ${p.rule_set_id} is another campaign's own rules. Copy it (Duplicate) instead of sharing it.`, 409)
    }
  }
}

/**
 * The same checks updateCampaign runs (person-only fields, live status, known owner, usable
 * rule set), for a writer that changes one campaign field outside updateCampaign — the
 * universal inline edit (lib/edit/update.ts). Throws CampaignError; changes nothing.
 */
export async function guardCampaignEdit(q: Queryable, actor: string, campaignId: number, p: CampaignPatch): Promise<void> {
  const cur = await q.query<{ rule_set_id: number | null }>('select rule_set_id from lp.campaigns where id = $1', [campaignId])
  if (!cur.rows[0]) throw new CampaignError(`No campaign ${campaignId}.`, 404)
  await requireHumanFor(q, actor, Object.keys(p) as CampaignField[])
  const currentRuleSet = cur.rows[0].rule_set_id == null ? null : Number(cur.rows[0].rule_set_id)
  await checkRefs(q, p, campaignId, currentRuleSet)
}

function show(field: CampaignField, v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (field === 'pool') return POOL_LABELS[v as keyof typeof POOL_LABELS] ?? String(v)
  if (field === 'is_template') return v ? 'yes' : 'no'
  return String(v)
}

export async function createCampaign(
  db: Tx,
  actor: string,
  p: CampaignPatch & { name: string },
  opts: { based_on?: number | null; via?: string } = {},
): Promise<Campaign> {
  return db.tx(async (q) => {
    if (p.rule_set_id != null) await requireHumanFor(q, actor, ['rule_set_id'])
    await checkRefs(q, p)
    const { rows } = await q.query<Record<string, unknown>>(
      `insert into lp.campaigns as c (name, pool, goal, notes, owner, status, rule_set_id, is_template, based_on, created_by, updated_by)
       values ($1, coalesce($2, 'jeweler'), $3, $4, $5, coalesce($6, 'draft'), $7, coalesce($8, false), $9, $10, $10)
       returning ${COLS}`,
      [p.name, p.pool ?? null, p.goal ?? null, p.notes ?? null, p.owner === undefined ? actor : p.owner, p.status ?? null,
       p.rule_set_id ?? null, p.is_template ?? null, opts.based_on ?? null, actor],
    )
    const c = row(rows[0])
    await logEvent(q, {
      actor,
      kind: 'campaign.created',
      summary: `${actor} created the campaign "${c.name}" (${POOL_LABELS[c.pool]}, ${c.status})`,
      entity_type: 'campaign',
      entity_id: c.id,
      data: { campaign: c, via: opts.via ?? null },
    })
    return c
  }, actor)
}

export interface UpdateResult {
  campaign: Campaign
  changes: { field: CampaignField; from: string | null; to: string | null }[]
}

export async function updateCampaign(db: Tx, actor: string, id: number, p: CampaignPatch): Promise<UpdateResult> {
  return db.tx(async (q) => {
    const before = await q.query<Record<string, unknown>>(`select ${COLS} from lp.campaigns c where c.id = $1 for update`, [id])
    if (!before.rows[0]) throw new CampaignError(`No campaign ${id}.`, 404)
    const old = row(before.rows[0])
    const changed = (Object.keys(p) as CampaignField[]).filter((k) => (p[k] ?? null) !== (old[k] ?? null))
    if (!changed.length) return { campaign: old, changes: [] }
    await requireHumanFor(q, actor, changed)
    await checkRefs(q, Object.fromEntries(changed.map((k) => [k, p[k]])) as CampaignPatch, id, old.rule_set_id)
    const sets = changed.map((k, i) => `${k} = $${i + 2}`)
    const { rows } = await q.query<Record<string, unknown>>(
      `update lp.campaigns c set ${sets.join(', ')}, updated_by = $${changed.length + 2} where c.id = $1 returning ${COLS}`,
      [id, ...changed.map((k) => p[k] ?? null), actor],
    )
    const c = row(rows[0])
    const changes = changed.map((k) => ({ field: k, from: show(k, old[k]), to: show(k, c[k]) }))
    const words = changes.map((x) => `${FIELD_WORDS[x.field]}: ${x.from ?? '(empty)'} → ${x.to ?? '(empty)'}`)
    const isArchive = changes.some((x) => x.field === 'status') && (await q.query<{ a: boolean }>('select is_archived as a from lp.campaign_statuses where id = $1', [c.status])).rows[0]?.a
    await logEvent(q, {
      actor,
      kind: isArchive ? 'campaign.archived' : 'campaign.updated',
      summary: `${actor} changed the campaign "${c.name}": ${words.join('; ')}`.slice(0, 2000),
      entity_type: 'campaign',
      entity_id: c.id,
      data: { changes },
    })
    return { campaign: c, changes }
  }, actor)
}

export async function archiveCampaign(db: Tx, actor: string, id: number): Promise<UpdateResult> {
  const { rows } = await (db as unknown as Queryable).query<{ id: string }>(
    'select id from lp.campaign_statuses where is_archived and active order by sort limit 1',
  )
  if (!rows[0]) throw new CampaignError('No archive status is set up.')
  return updateCampaign(db, actor, id, { status: rows[0].id })
}

/**
 * Copy a campaign (or a template): its settings and, unless asked not to, its
 * lead list with each lead's overrides. The copy starts as a draft and is a
 * template only when asked. If the source has its OWN rules (a scope 'campaign'
 * rule set), the copy gets its own copy of them, never a shared pointer; an agent
 * can't create rule sets, so an agent's copy falls back to the pool's rules and
 * says so. Worker C's email steps are copied by its own code (lib/campaign-steps).
 */
export async function duplicateCampaign(
  db: Tx,
  actor: string,
  id: number,
  opts: { name?: string | null; withLeads?: boolean; asTemplate?: boolean } = {},
): Promise<{ campaign: Campaign; leads_copied: number; rules: 'copied' | 'shared' | 'pool' | 'none' }> {
  const q0 = db as unknown as Queryable
  const src0 = await getCampaign(q0, id)
  if (!src0) throw new CampaignError(`No campaign ${id}.`, 404)
  const name = (opts.name ?? '').trim() || `${src0.name} (copy)`.slice(0, 120)
  if (name.length > 120) throw new CampaignError('Name is too long (max 120 characters).')
  let ruleSetId: number | null = src0.rule_set_id
  let rules: 'copied' | 'shared' | 'pool' | 'none' = ruleSetId == null ? 'none' : 'shared'
  if (ruleSetId != null && (await ruleSetScope(q0, ruleSetId)) === 'campaign') {
    if (rulesWriter && (await isHuman(q0, actor))) {
      ruleSetId = await rulesWriter.createOwn(db, actor, { name: `Campaign: ${name}`, pool: src0.pool, fromId: ruleSetId })
      rules = 'copied'
    } else {
      ruleSetId = null
      rules = 'pool'
    }
  }
  return db.tx(async (q) => {
    const src = await getCampaign(q, id)
    if (!src) throw new CampaignError(`No campaign ${id}.`, 404)
    const { rows } = await q.query<Record<string, unknown>>(
      `insert into lp.campaigns as c (name, pool, goal, notes, owner, status, rule_set_id, is_template, based_on, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $9) returning ${COLS}`,
      [name, src.pool, src.goal, src.notes, actor, ruleSetId, Boolean(opts.asTemplate), src.id, actor],
    )
    const c = row(rows[0])
    let leads = 0
    if (opts.withLeads !== false) {
      const r = await q.query(
        `insert into lp.campaign_leads (campaign_id, company_id, contact_id, overrides, note, added_via, added_by, updated_by)
         select $1, company_id, contact_id, overrides, note, 'copy', $2, $2 from lp.campaign_leads where campaign_id = $3`,
        [c.id, actor, src.id],
      )
      leads = Number(r.rowCount ?? 0)
    }
    const rulesWords = rules === 'copied' ? '; its own rules were copied' : rules === 'pool' ? '; it uses the pool’s rules (a person can copy the source’s own rules)' : ''
    await logEvent(q, {
      actor,
      kind: 'campaign.duplicated',
      summary: `${actor} made "${c.name}" from ${src.is_template ? 'the template' : 'the campaign'} "${src.name}"${opts.withLeads !== false ? ` with its ${leads} lead${leads === 1 ? '' : 's'}` : ' (no leads)'}${rulesWords}`,
      entity_type: 'campaign',
      entity_id: c.id,
      data: { from: src.id, leads_copied: leads, as_template: Boolean(opts.asTemplate), rules, rule_set_id: ruleSetId },
    })
    return { campaign: c, leads_copied: leads, rules }
  }, actor)
}

/** Give a campaign its own rules: a copy of what it uses now, through PR 1's createRuleSet. Humans only. */
export async function makeOwnRules(db: Tx, actor: string, id: number): Promise<UpdateResult> {
  const q0 = db as unknown as Queryable
  if (!rulesWriter) throw new CampaignError('Own rules per campaign arrive with the rules update; until then the pool’s rules apply.')
  if (!(await isHuman(q0, actor))) throw new CampaignError('Only a person can give a campaign its own rules.', 403)
  const c = await getCampaign(q0, id)
  if (!c) throw new CampaignError(`No campaign ${id}.`, 404)
  if ((await ruleSetScope(q0, c.rule_set_id)) === 'campaign') throw new CampaignError('This campaign already has its own rules.', 409)
  const now = await ruleSetFor(q0, c)
  const newId = await rulesWriter.createOwn(db, actor, { name: `Campaign: ${c.name}`, pool: c.pool, fromId: now?.id ?? null })
  return updateCampaign(db, actor, id, { rule_set_id: newId })
}

/** Add a status to the list (config, not code). Human or agent; logged. */
export async function addStatus(db: Tx, actor: string, input: { id: string; label: string; is_archived?: boolean; sort?: number }): Promise<CampaignStatus> {
  const id = input.id.trim().toLowerCase()
  const label = input.label.trim()
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(id)) throw new CampaignError('Status id: lowercase letters, digits and _, starting with a letter.')
  if (!label || label.length > 40) throw new CampaignError('Status label: 1–40 characters.')
  return db.tx(async (q) => {
    const exists = await q.query('select 1 from lp.campaign_statuses where id = $1', [id])
    if (exists.rows[0]) throw new CampaignError(`The status "${id}" already exists.`, 409)
    const { rows } = await q.query<CampaignStatus>(
      `insert into lp.campaign_statuses (id, label, sort, is_archived, created_by) values ($1, $2, $3, $4, $5)
       returning id, label, sort, is_archived, active`,
      [id, label, Number.isFinite(input.sort) ? Math.trunc(Number(input.sort)) : 50, Boolean(input.is_archived), actor],
    )
    await logEvent(q, {
      actor,
      kind: 'campaign.status_added',
      summary: `${actor} added the campaign status "${label}"${input.is_archived ? ' (counts as archived)' : ''}`,
      entity_type: 'campaign_status',
      entity_id: id,
      data: { status: rows[0] },
    })
    return rows[0]
  }, actor)
}

/** Switch a status on/off for new picks. Campaigns already in it keep it. */
export async function setStatusActive(db: Tx, actor: string, id: string, active: boolean): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ active: boolean; label: string }>('select active, label from lp.campaign_statuses where id = $1 for update', [id])
    if (!rows[0]) throw new CampaignError(`No status "${id}".`, 404)
    if (rows[0].active === active) return
    if (!active && ['draft', 'archived'].includes(id)) throw new CampaignError(`"${id}" is used by Duplicate/Archive and can't be switched off.`)
    await q.query('update lp.campaign_statuses set active = $2 where id = $1', [id, active])
    await logEvent(q, {
      actor,
      kind: 'campaign.status_changed',
      summary: `${actor} switched the campaign status "${rows[0].label}" ${active ? 'on' : 'off'}`,
      entity_type: 'campaign_status',
      entity_id: id,
      data: { changes: [{ field: 'active', from: String(rows[0].active), to: String(active) }] },
    })
  }, actor)
}
