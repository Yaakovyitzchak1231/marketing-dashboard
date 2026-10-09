/**
 * Rule sets in the database: read, resolve which set a campaign uses, create,
 * save (human only, logged old -> new, re-score queued), and agents' proposals
 * through Needs your OK.
 *
 * Which rules a campaign uses: its own set if it has one, else its pool's
 * (lp.campaign_meta.segment), else the default. A campaign created tomorrow
 * therefore has rules the moment it exists.
 */
import type { Db, Queryable } from '../db/types.ts'
import { logEvent } from '../ops/events.ts'
import { decideApproval, requestApproval, OpsError } from '../ops/core.ts'
import { describeField, describeRequirement, parseRuleDoc, RulesError, SEGMENTS, type PersonalizationField, type Requirement, type RuleDoc } from './schema.ts'
import { queueRecompute } from './recompute.ts'

export type RuleScope = 'default' | 'pool' | 'campaign' | 'template'

export interface RuleSetRow {
  id: number
  name: string
  scope: RuleScope
  segment: string | null
  campaign_id: string | null
  campaign_name: string | null
  requirements: Requirement[]
  fields: PersonalizationField[]
  version: number
  based_on: number | null
  archived: boolean
  updated_by: string | null
  updated_at: Date
  created_at: Date
}

const COLS = `id, name, scope, segment, campaign_id, campaign_name, requirements, fields, version, based_on, archived, updated_by, updated_at, created_at`

function row(r: RuleSetRow): RuleSetRow {
  return { ...r, id: Number(r.id), version: Number(r.version), based_on: r.based_on == null ? null : Number(r.based_on) }
}

export async function listRuleSets(q: Queryable, opts: { archived?: boolean } = {}): Promise<RuleSetRow[]> {
  const { rows } = await q.query<RuleSetRow>(
    `select ${COLS} from lp.rule_sets ${opts.archived ? '' : 'where not archived'}
      order by case scope when 'default' then 0 when 'pool' then 1 when 'campaign' then 2 else 3 end,
               array_position(array['jeweler','ai_agency','ai_builder','other']::text[], segment), name, id`,
  )
  return rows.map(row)
}

export async function getRuleSet(q: Queryable, id: number): Promise<RuleSetRow | null> {
  const { rows } = await q.query<RuleSetRow>(`select ${COLS} from lp.rule_sets where id = $1`, [id])
  return rows[0] ? row(rows[0]) : null
}

/**
 * The rule set that applies, most specific first:
 *   ruleSetId (a dashboard campaign's lp.campaigns.rule_set_id, if set and not archived)
 *   > the set whose campaign_id = campaignKey (an Instantly campaign's own rules)
 *   > the pool's set (segment, else lp.campaign_meta.segment for campaignKey)
 *   > the default.
 */
export async function effectiveRuleSet(
  q: Queryable,
  opts: { ruleSetId?: number | null; campaignKey?: string | null; segment?: string | null },
): Promise<RuleSetRow> {
  const { rows } = await q.query<RuleSetRow>(
    `with meta as (select segment from lp.campaign_meta where campaign_id = $2)
     select ${COLS} from lp.rule_sets r
      where not r.archived and (
            r.id = $1
         or (r.scope = 'campaign' and r.campaign_id = $2)
         or (r.scope = 'pool' and r.segment = coalesce($3, (select segment from meta)))
         or r.scope = 'default')
      order by case when r.id = $1 then 0 when r.scope = 'campaign' and r.campaign_id = $2 then 1 when r.scope = 'pool' then 2 else 3 end
      limit 1`,
    [opts.ruleSetId ?? null, opts.campaignKey ?? '', opts.segment ?? null],
  )
  if (!rows[0]) throw new RulesError('No lead rules exist yet. Run the database migrations (0010).', 503)
  return row(rows[0])
}

/**
 * The rule set an Instantly campaign uses right now. When a dashboard campaign is linked to
 * this Instantly campaign (0012: lp.campaigns.instantly_campaign_id), its rules win, so the
 * upload scores leads exactly as the dashboard campaign shows them:
 *   linked dashboard campaign: effectiveRuleSet({ ruleSetId: its rule_set_id, segment: its pool });
 *   otherwise: Instantly-keyed set > pool (campaign_meta) > default.
 */
export async function ruleSetForCampaign(q: Queryable, campaignId: string | null, segmentHint?: string | null): Promise<RuleSetRow> {
  if (campaignId) {
    // A dashboard campaign linked to this Instantly campaign (0012) owns the rules:
    // its own set (rule_set_id) > its pool's > the default, exactly as the dashboard shows it.
    const { rows: linked } = await q.query<{ rule_set_id: number | null; pool: string | null }>(
      `select rule_set_id, pool from lp.campaigns where instantly_campaign_id = $1 order by id limit 1`,
      [campaignId.toLowerCase()],
    )
    const c = linked[0]
    if (c) return effectiveRuleSet(q, { ruleSetId: c.rule_set_id == null ? null : Number(c.rule_set_id), segment: c.pool })
  }
  const { rows } = await q.query<{ segment: string | null }>('select segment from lp.campaign_meta where campaign_id = $1', [campaignId ?? ''])
  return effectiveRuleSet(q, { campaignKey: campaignId, segment: rows[0]?.segment ?? segmentHint ?? null })
}

/** The rule sets that score a lead in this pool: the pool's own, and campaigns with their own rules in that pool. */
export async function ruleSetsForSegment(q: Queryable, segment: string): Promise<RuleSetRow[]> {
  const { rows } = await q.query<RuleSetRow>(
    `select ${COLS} from lp.rule_sets r
      where not r.archived and (
            (r.scope = 'pool' and r.segment = $1)
         or (r.scope = 'campaign' and coalesce(r.segment, (select m.segment from lp.campaign_meta m where m.campaign_id = r.campaign_id), $1) = $1))
      order by case r.scope when 'pool' then 0 else 1 end, r.name`,
    [segment],
  )
  return rows.map(row)
}

async function requireHuman(q: Queryable, actor: string): Promise<string> {
  const { rows } = await q.query<{ kind: string; display_name: string }>('select kind, display_name from lp.actors where id = $1', [actor])
  if (!rows[0]) throw new RulesError(`Unknown actor ${actor}.`, 403)
  if (rows[0].kind !== 'human') throw new RulesError('Only a person can change lead rules. Agents can propose a change; it goes to Needs your OK.', 403)
  return rows[0].display_name
}

// ---------------------------------------------------------------- diff (old -> new, for the activity log)

export interface RuleChange {
  what: string
  item?: string
  old: unknown
  new: unknown
}

const SHOWN_REQ: (keyof Requirement)[] = ['label', 'enabled', 'field', 'op', 'value', 'min_confidence', 'max_age_days']
const SHOWN_FIELD: (keyof PersonalizationField)[] = ['name', 'source', 'required', 'fallback', 'min_confidence', 'max_age_days', 'enabled']
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function diffList<T extends { id: string }>(kind: string, before: T[], after: T[], keys: (keyof T)[], words: (x: T) => string): RuleChange[] {
  const out: RuleChange[] = []
  const old = new Map(before.map((x) => [x.id, x]))
  const now = new Map(after.map((x) => [x.id, x]))
  for (const x of before) if (!now.has(x.id)) out.push({ what: `${kind} removed`, item: x.id, old: words(x), new: null })
  for (const x of after) {
    const o = old.get(x.id)
    if (!o) {
      out.push({ what: `${kind} added`, item: x.id, old: null, new: words(x) })
      continue
    }
    for (const k of keys) if (!same(o[k], x[k])) out.push({ what: `${kind} ${String(k)}`, item: `${x.id} (${words(o)})`, old: o[k] ?? null, new: x[k] ?? null })
  }
  const keptOld = before.filter((x) => now.has(x.id)).map((x) => x.id)
  const keptNew = after.filter((x) => old.has(x.id)).map((x) => x.id)
  if (!same(keptOld, keptNew)) out.push({ what: `${kind} order`, old: keptOld, new: keptNew })
  return out
}

export function diffRuleDocs(before: RuleDoc, after: RuleDoc): RuleChange[] {
  const out: RuleChange[] = []
  if (before.name !== after.name) out.push({ what: 'name', old: before.name, new: after.name })
  out.push(...diffList('requirement', before.requirements, after.requirements, SHOWN_REQ, describeRequirement))
  out.push(...diffList('field', before.fields, after.fields, SHOWN_FIELD, describeField))
  return out
}

const v = (x: unknown) => (x === null || x === undefined ? 'none' : Array.isArray(x) ? x.join(', ') || 'none' : String(x))
export function changeWords(c: RuleChange): string {
  if (c.what.endsWith(' added')) return `added ${c.what.split(' ')[0]} "${v(c.new)}"`
  if (c.what.endsWith(' removed')) return `removed ${c.what.split(' ')[0]} "${v(c.old)}"`
  if (c.what.endsWith(' order')) return `reordered ${c.what.split(' ')[0]}s`
  return `${c.what}${c.item ? ` of ${c.item}` : ''}: ${v(c.old)} → ${v(c.new)}`
}

// ---------------------------------------------------------------- writes (humans only)

export async function saveRuleSet(
  db: Db,
  actor: string,
  id: number,
  input: unknown,
  opts: { base_version?: number | null; via_approval?: number | null; proposed_by?: string | null } = {},
): Promise<{ ruleSet: RuleSetRow; changes: RuleChange[] }> {
  const doc = parseRuleDoc(input)
  return db.tx(async (q) => {
    const who = await requireHuman(q, actor)
    const { rows } = await q.query<RuleSetRow>(`select ${COLS} from lp.rule_sets where id = $1 for update`, [id])
    const cur = rows[0] ? row(rows[0]) : null
    if (!cur || cur.archived) throw new RulesError('No rule set with that id.', 404)
    if (opts.base_version != null && Number(opts.base_version) !== cur.version) {
      throw new RulesError(`These rules changed since you opened them (now version ${cur.version}). Reload and try again.`, 409)
    }
    const changes = diffRuleDocs({ name: cur.name, requirements: cur.requirements, fields: cur.fields }, doc)
    if (!changes.length) return { ruleSet: cur, changes }
    const up = await q.query<RuleSetRow>(
      `update lp.rule_sets set name = $2, requirements = $3::jsonb, fields = $4::jsonb, version = version + 1, updated_by = $5
        where id = $1 returning ${COLS}`,
      [id, doc.name, JSON.stringify(doc.requirements), JSON.stringify(doc.fields), actor],
    )
    const saved = row(up.rows[0])
    const via = opts.via_approval ? ` (applying ${opts.proposed_by ?? 'an agent'}'s proposal #${opts.via_approval})` : ''
    await logEvent(q, {
      actor,
      kind: 'rules.updated',
      summary: `${who} changed the lead rules "${saved.name}"${via}: ${changes.slice(0, 4).map(changeWords).join('; ')}${changes.length > 4 ? `; and ${changes.length - 4} more` : ''}`,
      entity_type: 'rule_set',
      entity_id: id,
      data: { rule_set_id: id, version_from: cur.version, version_to: saved.version, changes, approval_id: opts.via_approval ?? null, proposed_by: opts.proposed_by ?? null },
    })
    await queueRecompute(q, id, saved.version, actor)
    return { ruleSet: saved, changes }
  }, actor)
}

export async function createRuleSet(
  db: Db,
  actor: string,
  input: { scope?: unknown; name?: unknown; campaign_id?: unknown; campaign_name?: unknown; segment?: unknown; from_id?: unknown },
): Promise<RuleSetRow> {
  const scope = String(input.scope ?? '')
  if (scope !== 'campaign' && scope !== 'template') throw new RulesError('scope must be campaign or template (the default and the pools always exist).')
  const hasFrom = input.from_id != null && input.from_id !== ''
  const fromId = Number(input.from_id)
  if (hasFrom && (!Number.isInteger(fromId) || fromId <= 0)) throw new RulesError('from_id must be a rule set id.')
  if (!hasFrom && scope === 'template') throw new RulesError('Pick a rule set to copy (from_id).')
  // campaign_id is optional: without it the set belongs to a dashboard campaign (lp.campaigns.rule_set_id).
  const rawCampaign = scope === 'campaign' ? String(input.campaign_id ?? '').trim() : ''
  const campaignId = rawCampaign || null
  if (campaignId && !/^[A-Za-z0-9_:.-]{1,80}$/.test(campaignId)) throw new RulesError('campaign_id must be an Instantly campaign id (letters, digits, _ - : .).')
  const segment = input.segment == null || input.segment === '' ? null : String(input.segment)
  if (segment && !(SEGMENTS as readonly string[]).includes(segment)) throw new RulesError(`segment must be one of ${SEGMENTS.join(', ')}.`)
  return db.tx(async (q) => {
    const who = await requireHuman(q, actor)
    // No from_id: start from the pool's rules (or the default).
    const from = hasFrom ? await getRuleSet(q, fromId) : await effectiveRuleSet(q, { segment })
    if (!from) throw new RulesError('The rule set to start from does not exist.', 404)
    if (scope === 'campaign' && campaignId) {
      const dup = await q.query('select 1 from lp.rule_sets where scope = $1 and campaign_id = $2 and not archived', ['campaign', campaignId])
      if (dup.rows.length) throw new RulesError('That campaign already has its own rules. Edit them instead.', 409)
    }
    const cname = input.campaign_name == null ? null : String(input.campaign_name).trim().slice(0, 200) || null
    const name = String(input.name ?? '').trim().slice(0, 120) || (scope === 'campaign' ? `Campaign: ${cname ?? campaignId ?? `copy of ${from.name}`}` : `Template: copy of ${from.name}`)
    const { rows } = await q.query<RuleSetRow>(
      `insert into lp.rule_sets (name, scope, segment, campaign_id, campaign_name, requirements, fields, based_on, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $9) returning ${COLS}`,
      [name, scope, segment, campaignId, cname, JSON.stringify(from.requirements), JSON.stringify(from.fields), from.id, actor],
    )
    const made = row(rows[0])
    await logEvent(q, {
      actor,
      kind: 'rules.created',
      summary: `${who} created lead rules "${made.name}" from "${from.name}"`,
      entity_type: 'rule_set',
      entity_id: made.id,
      data: { rule_set_id: made.id, scope, campaign_id: campaignId, segment, from_id: from.id, old: null, new: { name: made.name, requirements: made.requirements, fields: made.fields } },
    })
    if (scope === 'campaign') await queueRecompute(q, made.id, made.version, actor)
    return made
  }, actor)
}

/** Remove a campaign's own rules (it goes back to its pool's) or a template. Pools and the default can't be removed. */
export async function archiveRuleSet(db: Db, actor: string, id: number): Promise<RuleSetRow> {
  return db.tx(async (q) => {
    const who = await requireHuman(q, actor)
    const cur = await getRuleSet(q, id)
    if (!cur || cur.archived) throw new RulesError('No rule set with that id.', 404)
    if (cur.scope === 'default' || cur.scope === 'pool') throw new RulesError('The default and pool rules always exist; edit them instead.', 409)
    const { rows } = await q.query<RuleSetRow>(`update lp.rule_sets set archived = true, updated_by = $2 where id = $1 returning ${COLS}`, [id, actor])
    await q.query('delete from lp.lead_evaluations where rule_set_id = $1', [id])
    await q.query('delete from lp.rule_recompute where rule_set_id = $1', [id])
    await logEvent(q, {
      actor,
      kind: 'rules.removed',
      summary: `${who} removed lead rules "${cur.name}"${cur.scope === 'campaign' ? ' (the campaign now uses its pool\'s rules)' : ''}`,
      entity_type: 'rule_set',
      entity_id: id,
      data: { rule_set_id: id, old: { name: cur.name, requirements: cur.requirements, fields: cur.fields }, new: null },
    })
    return row(rows[0])
  }, actor)
}

// ---------------------------------------------------------------- agents: propose, a human applies

export interface RuleProposal {
  approval_id: number
  status: string
  requested_by: string
  requested_by_name: string | null
  created_at: Date
  rule_set_id: number
  base_version: number
  note: string | null
  proposed: RuleDoc
  changes: RuleChange[]
  applied_at: string | null
}

export const PROPOSAL_KIND = 'rule_set_change'

export async function proposeRuleChange(db: Db, agent: string, input: Record<string, unknown>) {
  const id = Number(input.rule_set_id)
  if (!Number.isInteger(id) || id <= 0) throw new OpsError('rule_set_id must be a positive integer')
  let doc: RuleDoc
  try {
    doc = parseRuleDoc(input)
  } catch (e) {
    if (e instanceof RulesError) throw new OpsError(e.message, e.status)
    throw e
  }
  const cur = await getRuleSet(db, id)
  if (!cur || cur.archived) throw new OpsError(`rule set ${id} not found`, 404)
  const changes = diffRuleDocs({ name: cur.name, requirements: cur.requirements, fields: cur.fields }, doc)
  if (!changes.length) throw new OpsError('That proposal changes nothing.')
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : null
  const approval = await requestApproval(db, agent, {
    action: 'other',
    summary: `change the lead rules "${cur.name}": ${changes.slice(0, 3).map(changeWords).join('; ')}${changes.length > 3 ? `; and ${changes.length - 3} more` : ''}. Review and apply on the Rules page (/rules/${id}).`,
    payload: { kind: PROPOSAL_KIND, rule_set_id: id, base_version: cur.version, proposed: doc, changes, note },
    expires_in_hours: 168,
  })
  return { approval_id: approval.id, status: approval.status, changes, review_at: `/rules/${id}` }
}

export async function listProposals(q: Queryable, ruleSetId?: number): Promise<RuleProposal[]> {
  const { rows } = await q.query<{ id: number; status: string; requested_by: string; name: string | null; created_at: Date; payload: Record<string, unknown> }>(
    `select a.id, a.status, a.requested_by, ac.display_name as name, a.created_at, a.payload
       from lp.approvals a left join lp.actors ac on ac.id = a.requested_by
      where a.payload->>'kind' = $1 and ($2::bigint is null or (a.payload->>'rule_set_id')::bigint = $2)
        and (a.status = 'pending' or (a.status = 'approved' and a.payload->>'applied_at' is null))
        and (a.expires_at is null or a.expires_at > now() or a.status = 'approved')
      order by a.created_at desc limit 50`,
    [PROPOSAL_KIND, ruleSetId ?? null],
  )
  return rows.map((r) => ({
    approval_id: Number(r.id),
    status: r.status,
    requested_by: r.requested_by,
    requested_by_name: r.name,
    created_at: r.created_at,
    rule_set_id: Number(r.payload.rule_set_id),
    base_version: Number(r.payload.base_version),
    note: (r.payload.note as string) ?? null,
    proposed: r.payload.proposed as RuleDoc,
    changes: (r.payload.changes as RuleChange[]) ?? [],
    applied_at: (r.payload.applied_at as string) ?? null,
  }))
}

async function loadProposal(q: Queryable, approvalId: number) {
  const { rows } = await q.query<{ id: number; status: string; requested_by: string; payload: Record<string, unknown> }>(
    'select id, status, requested_by, payload from lp.approvals where id = $1',
    [approvalId],
  )
  const a = rows[0]
  if (!a || a.payload?.kind !== PROPOSAL_KIND) throw new RulesError('No rule proposal with that id.', 404)
  return a
}

/** A human applies an agent's proposal: approve it (if still pending) and save it as their own change. */
export async function applyProposal(db: Db, actor: string, approvalId: number) {
  const a = await loadProposal(db, approvalId)
  if (a.payload.applied_at) throw new RulesError('That proposal was already applied.', 409)
  if (a.status !== 'pending' && a.status !== 'approved') throw new RulesError(`That proposal is ${a.status}.`, 409)
  await requireHuman(db, actor)
  const id = Number(a.payload.rule_set_id)
  const cur = await getRuleSet(db, id)
  if (!cur || cur.archived) throw new RulesError('The rule set this proposal changes no longer exists.', 404)
  if (cur.version !== Number(a.payload.base_version)) {
    throw new RulesError(`These rules changed after the proposal was made (version ${a.payload.base_version} → ${cur.version}). Reject it and ask for a fresh one.`, 409)
  }
  if (a.status === 'pending') await decideApproval(db, actor, approvalId, 'approved', 'Applied on the Rules page')
  const out = await saveRuleSet(db, actor, id, a.payload.proposed, {
    base_version: Number(a.payload.base_version),
    via_approval: approvalId,
    proposed_by: a.requested_by,
  })
  await db.query(`update lp.approvals set payload = payload || jsonb_build_object('applied_at', now()::text, 'applied_by', $2::text) where id = $1`, [approvalId, actor])
  return out
}

export async function rejectProposal(db: Db, actor: string, approvalId: number, note: string | null) {
  const a = await loadProposal(db, approvalId)
  await requireHuman(db, actor)
  if (a.status === 'pending') return decideApproval(db, actor, approvalId, 'rejected', note ?? undefined)
  if (a.status === 'approved' && !a.payload.applied_at) {
    await db.query(`update lp.approvals set payload = payload || jsonb_build_object('applied_at', 'dismissed', 'dismissed_by', $2::text) where id = $1`, [approvalId, actor])
    await logEvent(db, { actor, kind: 'rules.proposal_dismissed', summary: `Dismissed an approved but unapplied rule proposal #${approvalId}`, entity_type: 'approval', entity_id: approvalId, data: { note } })
    return null
  }
  throw new RulesError(`That proposal is ${a.status}.`, 409)
}
