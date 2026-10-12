/**
 * The action library — plan 3.8.
 *
 * A single registry of the things the dashboard can DO to a lead, built on
 * the existing writers instead of duplicating them:
 *   task.create      lib/ops/core.ts createTask
 *   lead.update      lib/edit/update.ts updateEntity
 *   suppression.add  lib/suppressions/store.ts addSuppression
 *   tag.add          lib/tags/store.ts addTag
 *   tag.remove       lib/tags/store.ts removeTag
 *
 * Journey steps (plan 3.1's runner) and agents call runAction; every
 * execution is recorded in lp.step_log by lib/actions/execute.ts.
 */
import type { Db } from '../db/types.ts'
import { createTask } from '../ops/core.ts'
import { updateEntity } from '../edit/update.ts'
import { addSuppression } from '../suppressions/store.ts'
import { addTag, removeTag } from '../tags/store.ts'

export class ActionError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ActionError'
    this.status = status
  }
}

export interface ActionDef {
  /** Stable key, e.g. 'task.create'. */
  key: string
  /** Short human label. */
  label: string
  /** One-line description for the UI and agent discovery. */
  description: string
  /** Argument documentation (mirrors the ops args style). */
  args: string
  run: (db: Db, actor: string, args: Record<string, unknown>) => Promise<unknown>
}

const posInt = (v: unknown, field: string): number => {
  const n = Math.floor(Number(v))
  if (!Number.isInteger(n) || n <= 0) throw new ActionError(`${field} must be a positive integer.`)
  return n
}

const str = (v: unknown, field: string, max = 500): string => {
  const s = String(v ?? '').trim()
  if (!s) throw new ActionError(`${field} is required.`)
  if (s.length > max) throw new ActionError(`${field} is too long (max ${max}).`)
  return s
}

export const ACTIONS: ActionDef[] = [
  {
    key: 'task.create',
    label: 'Create task',
    description: 'Create a follow-up task on a lead (the same writer the ops API uses).',
    args: '{title, company_id?, kind?, assigned_to?, priority?, body?}',
    run: (db, actor, a) =>
      createTask(db, actor, {
        title: str(a.title, 'title', 200),
        kind: typeof a.kind === 'string' ? a.kind : undefined,
        company_id: a.company_id == null ? null : posInt(a.company_id, 'company_id'),
        assigned_to: typeof a.assigned_to === 'string' ? a.assigned_to : undefined,
        priority: a.priority == null ? undefined : Math.floor(Number(a.priority)),
        body: typeof a.body === 'string' ? a.body : undefined,
      }),
  },
  {
    key: 'lead.update',
    label: 'Update lead field',
    description: 'Change one field on a company or contact (audited inline edit).',
    args: '{type: "company"|"contact", id, field, value, note?}',
    run: (db, actor, a) => {
      const type = String(a.type ?? '')
      if (type !== 'company' && type !== 'contact') throw new ActionError('type must be "company" or "contact".')
      return updateEntity(db, actor, {
        type,
        id: posInt(a.id, 'id'),
        field: str(a.field, 'field', 80),
        value: a.value,
        note: typeof a.note === 'string' ? a.note : null,
      })
    },
  },
  {
    key: 'suppression.add',
    label: 'Suppress',
    description: 'Suppress an email or domain so journeys never send to it.',
    args: '{email?, domain?, reason, campaign_id?, note?}',
    run: (db, actor, a) => {
      const email = typeof a.email === 'string' && a.email.trim() ? a.email.trim() : null
      const domain = typeof a.domain === 'string' && a.domain.trim() ? a.domain.trim() : null
      if (!email && !domain) throw new ActionError('Give an email or a domain to suppress.')
      return addSuppression(db, actor, {
        email,
        domain,
        reason: str(a.reason, 'reason', 200),
        campaign_id: a.campaign_id == null ? null : posInt(a.campaign_id, 'campaign_id'),
        source: 'action_library',
        note: typeof a.note === 'string' ? a.note : null,
      })
    },
  },
  {
    key: 'tag.add',
    label: 'Add tag',
    description: 'Tag a company (drives segments and journey branching).',
    args: '{company_id, tag}',
    run: (db, actor, a) =>
      addTag(db, actor, { company_id: posInt(a.company_id, 'company_id'), tag: str(a.tag, 'tag', 80) }),
  },
  {
    key: 'tag.remove',
    label: 'Remove tag',
    description: 'Remove a tag from a company.',
    args: '{company_id, tag}',
    run: (db, actor, a) =>
      removeTag(db, actor, { company_id: posInt(a.company_id, 'company_id'), tag: str(a.tag, 'tag', 80) }),
  },
]

const BY_KEY = new Map(ACTIONS.map((a) => [a.key, a]))

/** The whole library, for the UI and for GET /api/ops discovery. */
export function listActions(): { key: string; label: string; description: string; args: string }[] {
  return ACTIONS.map(({ key, label, description, args }) => ({ key, label, description, args }))
}

export function getAction(key: string): ActionDef {
  const a = BY_KEY.get(key)
  if (!a) throw new ActionError(`Unknown action "${key}". Known: ${[...BY_KEY.keys()].join(', ')}.`, 404)
  return a
}
