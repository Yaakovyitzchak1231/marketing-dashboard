/**
 * Email steps of a campaign: create, edit, reorder, delete. Every change writes one
 * activity-log event with the actor and each field's old -> new.
 * Humans (dashboard, actor 'owner') and agents (ops API, their own id) use the same functions.
 */
import type { Db, Queryable } from '../db/types.ts'
import { logEvent } from '../ops/events.ts'
import { getCampaign, type CampaignRef } from './adapter.ts'

export class StepsError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'StepsError'
    this.status = status
  }
}

export interface StepRow {
  id: number
  campaign_id: number
  step_number: number
  variant: string
  subject: string
  body: string
  delay_days: number
  created_by: string | null
  updated_by: string | null
  created_at: Date
  updated_at: Date
}

export interface StepInput {
  step_number?: number
  variant?: string
  subject?: string
  body?: string
  delay_days?: number
}

export interface FieldChange {
  field: string
  old: unknown
  new: unknown
}

const EDITABLE = ['step_number', 'variant', 'subject', 'body', 'delay_days'] as const
const MAX_STEPS = 50
const VARIANT = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,19}$/

const COLS = 'id, campaign_id, step_number, variant, subject, body, delay_days, created_by, updated_by, created_at, updated_at'
const num = (r: StepRow): StepRow => ({ ...r, id: Number(r.id), campaign_id: Number(r.campaign_id) })

/** Validate a partial step from a form or JSON body. Unknown keys are refused, so typos don't vanish silently. */
export function parseStepInput(raw: unknown, opts: { partial: boolean }): StepInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StepsError('Body must be JSON: {subject, body, delay_days, variant, step_number}')
  const r = raw as Record<string, unknown>
  for (const k of Object.keys(r)) if (!(EDITABLE as readonly string[]).includes(k)) throw new StepsError(`Unknown field "${k}". Editable: ${EDITABLE.join(', ')}.`)
  const out: StepInput = {}
  if (r.subject !== undefined) {
    if (typeof r.subject !== 'string') throw new StepsError('subject must be text.')
    if (r.subject.length > 300) throw new StepsError('subject is too long (300 characters max).')
    out.subject = r.subject.trim()
  }
  if (r.body !== undefined) {
    if (typeof r.body !== 'string') throw new StepsError('body must be text.')
    if (r.body.length > 10000) throw new StepsError('body is too long (10,000 characters max).')
    out.body = r.body.replace(/\r\n/g, '\n').trim()
  }
  if (r.delay_days !== undefined && r.delay_days !== '') {
    const n = Number(r.delay_days)
    if (!Number.isInteger(n) || n < 0 || n > 365) throw new StepsError('delay_days must be a whole number of days, 0-365.')
    out.delay_days = n
  }
  if (r.variant !== undefined && r.variant !== '') {
    const v = String(r.variant).trim()
    if (!VARIANT.test(v)) throw new StepsError('variant must be a short label: letters, digits, space, - or _ (20 max), e.g. "A".')
    out.variant = v
  }
  if (r.step_number !== undefined && r.step_number !== '') {
    const n = Number(r.step_number)
    if (!Number.isInteger(n) || n < 1 || n > MAX_STEPS) throw new StepsError(`step_number must be 1-${MAX_STEPS}.`)
    out.step_number = n
  }
  if (!opts.partial && out.subject === undefined && out.body === undefined) throw new StepsError('A step needs a subject or a body.')
  return out
}

async function requireCampaign(q: Queryable, campaignId: number): Promise<CampaignRef> {
  const c = await getCampaign(q, campaignId)
  if (!c) throw new StepsError(`No campaign ${campaignId}.`, 404)
  return c
}

export async function listSteps(q: Queryable, campaignId: number): Promise<StepRow[]> {
  const { rows } = await q.query<StepRow>(
    `select ${COLS} from lp.campaign_steps where campaign_id = $1 order by step_number, lower(variant), id`,
    [campaignId],
  )
  return rows.map(num)
}

async function getStep(q: Queryable, campaignId: number, stepId: number): Promise<StepRow> {
  const { rows } = await q.query<StepRow>(`select ${COLS} from lp.campaign_steps where id = $1 and campaign_id = $2`, [stepId, campaignId])
  if (!rows[0]) throw new StepsError(`No step ${stepId} in campaign ${campaignId}.`, 404)
  return num(rows[0])
}

function label(s: Pick<StepRow, 'step_number' | 'variant'>) {
  return `step ${s.step_number}${s.variant && s.variant.toUpperCase() !== 'A' ? ` (variant ${s.variant})` : ''}`
}

function clash(e: unknown): never {
  if (e && typeof e === 'object' && 'message' in e && /campaign_steps_uq|duplicate key/.test(String((e as Error).message))) {
    throw new StepsError('That step number already has a step with this variant label. Use another variant label (e.g. "B") or step number.', 409)
  }
  throw e
}

export async function createStep(db: Db, actor: string, campaignId: number, input: StepInput): Promise<StepRow> {
  return db.tx(async (q) => {
    const c = await requireCampaign(q, campaignId)
    const { rows: cnt } = await q.query<{ n: number; max: number | null }>(
      `select count(*)::int as n, max(step_number) as max from lp.campaign_steps where campaign_id = $1`,
      [campaignId],
    )
    if (Number(cnt[0].n) >= MAX_STEPS * 3) throw new StepsError('This campaign already has the most steps allowed.')
    const stepNumber = input.step_number ?? Math.min(Number(cnt[0].max ?? 0) + 1, MAX_STEPS)
    let row: StepRow
    try {
      const { rows } = await q.query<StepRow>(
        `insert into lp.campaign_steps (campaign_id, step_number, variant, subject, body, delay_days, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $7) returning ${COLS}`,
        [campaignId, stepNumber, input.variant ?? 'A', input.subject ?? '', input.body ?? '', input.delay_days ?? (stepNumber === 1 ? 0 : 3), actor],
      )
      row = num(rows[0])
    } catch (e) {
      clash(e)
    }
    await logEvent(q, {
      actor,
      kind: 'campaign.step_added',
      summary: `Added ${label(row)} to campaign "${c.name}": "${row.subject || '(no subject)'}"`,
      entity_type: 'campaign',
      entity_id: campaignId,
      data: { step_id: row.id, changes: EDITABLE.map((f) => ({ field: f, old: null, new: row[f] })) },
    })
    return row
  }, actor)
}

export async function updateStep(db: Db, actor: string, campaignId: number, stepId: number, patch: StepInput): Promise<{ step: StepRow; changes: FieldChange[] }> {
  return db.tx(async (q) => {
    const c = await requireCampaign(q, campaignId)
    const before = await getStep(q, campaignId, stepId)
    const changes: FieldChange[] = []
    for (const f of EDITABLE) {
      const v = patch[f]
      if (v !== undefined && v !== before[f]) changes.push({ field: f, old: before[f], new: v })
    }
    if (!changes.length) return { step: before, changes }
    const sets = changes.map((ch, i) => `${ch.field} = $${i + 3}`).join(', ')
    let step: StepRow
    try {
      const { rows } = await q.query<StepRow>(
        `update lp.campaign_steps set ${sets}, updated_by = $${changes.length + 3} where id = $1 and campaign_id = $2 returning ${COLS}`,
        [stepId, campaignId, ...changes.map((ch) => ch.new), actor],
      )
      step = num(rows[0])
    } catch (e) {
      clash(e)
    }
    await logEvent(q, {
      actor,
      kind: 'campaign.step_edited',
      summary: `Edited ${label(before)} of campaign "${c.name}": ${changes.map((ch) => (ch.field === 'body' ? 'body' : `${ch.field} ${short(ch.old)} \u2192 ${short(ch.new)}`)).join('; ')}`,
      entity_type: 'campaign',
      entity_id: campaignId,
      data: { step_id: stepId, changes },
    })
    return { step, changes }
  }, actor)
}

function short(v: unknown): string {
  const s = v == null || v === '' ? '(empty)' : String(v)
  return s.length > 60 ? `"${s.slice(0, 57)}..."` : `"${s}"`
}

export async function deleteStep(db: Db, actor: string, campaignId: number, stepId: number): Promise<{ deleted: StepRow }> {
  return db.tx(async (q) => {
    const c = await requireCampaign(q, campaignId)
    const before = await getStep(q, campaignId, stepId)
    await q.query(`delete from lp.campaign_steps where id = $1`, [stepId])
    await logEvent(q, {
      actor,
      kind: 'campaign.step_deleted',
      summary: `Deleted ${label(before)} of campaign "${c.name}": "${before.subject || '(no subject)'}"`,
      entity_type: 'campaign',
      entity_id: campaignId,
      // The whole step is kept in the log, so a deleted step can be re-created from it.
      data: { step_id: stepId, changes: EDITABLE.map((f) => ({ field: f, old: before[f], new: null })) },
    })
    return { deleted: before }
  }, actor)
}

/**
 * Reorder: `order` lists the current step numbers in their new order (every step number
 * exactly once). Variants of a step move together. Logged as old -> new numbers.
 */
export async function reorderSteps(db: Db, actor: string, campaignId: number, order: unknown): Promise<StepRow[]> {
  if (!Array.isArray(order) || !order.length) throw new StepsError('order must be a list of the current step numbers, in the new order.')
  const wanted = order.map(Number)
  return db.tx(async (q) => {
    const c = await requireCampaign(q, campaignId)
    const steps = await listSteps(q, campaignId)
    const current = [...new Set(steps.map((s) => s.step_number))].sort((a, b) => a - b)
    const same = wanted.length === current.length && new Set(wanted).size === wanted.length && wanted.every((n) => current.includes(n))
    if (!same) throw new StepsError(`order must list each current step number once: ${current.join(', ')}.`)
    const map = new Map(wanted.map((oldNo, i) => [oldNo, i + 1]))
    const moves = [...map].filter(([o, n]) => o !== n).map(([o, n]) => ({ old: o, new: n }))
    if (!moves.length) return steps
    // Two passes so the unique index never sees a temporary clash.
    await q.query(`update lp.campaign_steps set step_number = step_number + 500, updated_by = $2 where campaign_id = $1`, [campaignId, actor])
    for (const [o, n] of map) {
      await q.query(`update lp.campaign_steps set step_number = $3 where campaign_id = $1 and step_number = $2`, [campaignId, o + 500, n])
    }
    await logEvent(q, {
      actor,
      kind: 'campaign.steps_reordered',
      summary: `Reordered the steps of campaign "${c.name}": ${moves.map((m) => `step ${m.old} \u2192 ${m.new}`).join(', ')}`,
      entity_type: 'campaign',
      entity_id: campaignId,
      data: { changes: moves.map((m) => ({ field: 'step_number', old: m.old, new: m.new })) },
    })
    return listSteps(q, campaignId)
  }, actor)
}
