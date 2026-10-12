/**
 * Lead event ops for agents (POST /api/ops {op, ...} and the REST aliases in
 * lib/ops/dispatch.ts): track_event / track_events write to lp.lead_events
 * through lib/events/emit.ts; recent_lead_events / list_event_types read it;
 * register_event_type lets an agent add a new key without a deploy.
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { isEditorActor, requireEditorActor } from '../ops/actor-role.ts'
import { registerEventType, updateEventType, EventTypeError } from './types-store.ts'
import { emitLeadEvent, emitLeadEvents, EventError, type EmitLeadEventInput } from './emit.ts'
import { evaluateCompositeRules } from './composite'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

export const TRACK_EVENTS_MAX = 500

async function typeErr<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof EventTypeError) throw new OpsError(e.message, e.status)
    throw e
  }
}

function id(v: unknown, field: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new OpsError(`${field} must be a positive integer`)
  return n
}

function parseProps(v: unknown): Record<string, unknown> {
  if (v === undefined) return {}
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new OpsError('props must be an object')
  return v as Record<string, unknown>
}

/** One event's args -> an EmitLeadEventInput, or throws OpsError on anything malformed (not on an unknown type — that's checked at insert time). */
function parseEventInput(a: Args, actor: string): EmitLeadEventInput {
  const type = typeof a.type === 'string' ? a.type.trim() : ''
  if (!type) throw new OpsError('type is required')
  const companyId = a.company_id == null ? null : id(a.company_id, 'company_id')
  const contactId = a.contact_id == null ? null : id(a.contact_id, 'contact_id')
  const email = typeof a.email === 'string' && a.email.trim() ? a.email : null
  if (companyId == null && contactId == null && !email) throw new OpsError('give company_id, contact_id or email so the event lands on a lead')
  return {
    type,
    company_id: companyId,
    contact_id: contactId,
    email,
    campaign_id: a.campaign_id == null ? null : id(a.campaign_id, 'campaign_id'),
    instantly_campaign_id: typeof a.instantly_campaign_id === 'string' ? a.instantly_campaign_id : null,
    step: a.step == null ? null : Number(a.step),
    source: typeof a.source === 'string' && a.source.trim() ? a.source.trim() : 'ops_api',
    actor,
    props: parseProps(a.props),
    occurred_at: typeof a.occurred_at === 'string' ? a.occurred_at : null,
    dedupe_key: typeof a.dedupe_key === 'string' && a.dedupe_key.trim() ? a.dedupe_key.trim() : null,
  }
}

type TrackResult = { ok: true; inserted: boolean; id: number | null; type: string; company_id: number | null; contact_id: number | null } | { ok: false; error: string }

const RAW: Record<string, Op> = {
  track_event: {
    args: '{type, company_id? | contact_id? | email, props?, occurred_at?, dedupe_key?, campaign_id?, instantly_campaign_id?, step?, source?}  -> the recorded event, or {inserted:false} for a repeated dedupe_key',
    run: async (db, actor, a) => {
      const input = parseEventInput(a, actor)
      try {
        return await db.tx(async (q) => {
          const r = await emitLeadEvent(q, input)
          // Composite rules (e.g. positive_reply) derive from a combination of
          // events; evaluate after every successful insert.
          if (r.inserted && r.id != null) {
            await evaluateCompositeRules(q, {
              id: r.id,
              type: r.type,
              company_id: r.company_id,
              contact_id: r.contact_id,
              campaign_id: input.campaign_id ?? null,
            })
          }
          return r
        }, actor)
      } catch (e) {
        if (e instanceof EventError) throw new OpsError(e.message, e.status)
        throw e
      }
    },
  },
  track_events: {
    args: `{events: [{type, company_id?|contact_id?|email, props?, occurred_at?, dedupe_key?, campaign_id?, instantly_campaign_id?, step?, source?}]}  -- at most ${TRACK_EVENTS_MAX} -> one {ok, ...} result per item, same order, partial success (a bad item never fails the others)`,
    run: async (db, actor, a) => {
      const list = Array.isArray(a.events) ? a.events : null
      if (!list) throw new OpsError('events must be an array')
      if (!list.length) throw new OpsError('events is empty')
      if (list.length > TRACK_EVENTS_MAX) throw new OpsError(`at most ${TRACK_EVENTS_MAX} events per call (sent ${list.length})`)

      // Parse each item independently; a malformed item (bad ids, no identity, no type)
      // is a failed result right away and never reaches the database.
      const parsed: ({ input: EmitLeadEventInput } | { error: string })[] = list.map((raw) => {
        try {
          return { input: parseEventInput((raw ?? {}) as Args, actor) }
        } catch (e) {
          return { error: e instanceof OpsError ? e.message : 'invalid event' }
        }
      })

      const okIdx: number[] = []
      parsed.forEach((p, i) => {
        if ('input' in p) okIdx.push(i)
      })
      const results: TrackResult[] = parsed.map((p) => ('error' in p ? { ok: false, error: p.error } : { ok: false, error: 'not processed' }))
      if (!okIdx.length) return results

      await db.tx(async (q) => {
        const types = [...new Set(okIdx.map((i) => (parsed[i] as { input: EmitLeadEventInput }).input.type))]
        const { rows } = await q.query<{ key: string }>('select key from lp.event_types where key = any($1::text[]) and active', [types])
        const known = new Set(rows.map((r) => r.key))
        const ready = okIdx.filter((i) => known.has((parsed[i] as { input: EmitLeadEventInput }).input.type))
        for (const i of okIdx) {
          if (!known.has((parsed[i] as { input: EmitLeadEventInput }).input.type)) {
            const type = (parsed[i] as { input: EmitLeadEventInput }).input.type
            results[i] = { ok: false, error: `unknown event type '${type}' — register it first with register_event_type` }
          }
        }
        if (ready.length) {
          const inserted = await emitLeadEvents(
            q,
            ready.map((i) => (parsed[i] as { input: EmitLeadEventInput }).input),
          )
          ready.forEach((i, k) => {
            results[i] = { ok: true, ...inserted[k] }
          })
          for (let k = 0; k < ready.length; k++) {
            const ins = inserted[k]
            if (!ins.inserted || ins.id == null) continue
            const inp = (parsed[ready[k]] as { input: EmitLeadEventInput }).input
            await evaluateCompositeRules(q, {
              id: ins.id,
              type: ins.type,
              company_id: ins.company_id,
              contact_id: ins.contact_id,
              campaign_id: inp.campaign_id ?? null,
            })
          }
        }
      }, actor)
      return results
    },
  },
  recent_lead_events: {
    args: '{company_id? | contact_id? | campaign_id?, type?, since?, limit? (default 50, max 500)}  -- at least one of company_id, contact_id, campaign_id, type is required',
    run: async (db, _actor, a) => {
      const companyId = a.company_id == null ? null : id(a.company_id, 'company_id')
      const contactId = a.contact_id == null ? null : id(a.contact_id, 'contact_id')
      const campaignId = a.campaign_id == null ? null : id(a.campaign_id, 'campaign_id')
      const type = typeof a.type === 'string' ? a.type.trim() : null
      if (companyId == null && contactId == null && campaignId == null && !type) {
        throw new OpsError('give at least one of company_id, contact_id, campaign_id or type')
      }
      const since = typeof a.since === 'string' && !Number.isNaN(Date.parse(a.since)) ? new Date(a.since) : null
      const limit = Math.min(500, Math.max(1, Number(a.limit) || 50))
      const { rows } = await db.query(
        `select e.*, et.label as type_label, c.name as campaign_name
           from lp.lead_events e
           left join lp.event_types et on et.key = e.type
           left join lp.campaigns c on c.id = e.campaign_id
          where ($1::bigint is null or e.company_id = $1)
            and ($2::bigint is null or e.contact_id = $2)
            and ($3::bigint is null or e.campaign_id = $3)
            and ($4::text is null or e.type = $4)
            and ($5::timestamptz is null or e.occurred_at >= $5)
          order by e.occurred_at desc, e.id desc
          limit $6`,
        [companyId, contactId, campaignId, type, since, limit],
      )
      return rows
    },
  },
  list_event_types: {
    args: '{category?, active_only? (default true)}',
    run: async (db, _actor, a) => {
      const category = typeof a.category === 'string' ? a.category : null
      const activeOnly = a.active_only !== false && a.active_only !== 'false'
      const { rows } = await db.query(
        `select key, label, category, source, props_schema, active, created_by, created_at from lp.event_types
          where ($1::text is null or category = $1) and (not $2 or active)
          order by category, key`,
        [category, activeOnly],
      )
      return rows
    },
  },
  register_event_type: {
    args: '{key (slug), label, category: email|lifecycle|verification|web|social|meeting|deal|signal|custom, props_schema? (JSON object, max 16 KB)}  -- any authenticated actor may register a NEW type; an existing key is 409 for agents (a person, editor or owner, may relabel it), and a built-in key (source instantly/system) is 409 for everyone',
    run: (db, actor, a) =>
      typeErr(() =>
        db.tx(async (q) => {
          const canRelabel = await isEditorActor(q, actor)
          return registerEventType(q, actor, { key: a.key, label: a.label, category: a.category, props_schema: a.props_schema }, { canRelabel })
        }, actor),
      ),
  },
  update_event_type: {
    args: '{key, label?, category?, active?}  -- people only (editor or owner); agents get 403. Changes a custom type (never its key); built-in types (source instantly/system) are 409. active:false makes track_event refuse the key',
    run: (db, actor, a) => {
      const key = typeof a.key === 'string' ? a.key.trim() : ''
      if (!key) throw new OpsError('key is required')
      return typeErr(() => db.tx(async (q) => {
        await requireEditorActor(q, actor, 'update_event_type is for people (editor or owner); an agent can register new types but not change existing ones')
        return updateEventType(q, actor, key, { label: a.label, category: a.category, active: a.active })
      }, actor))
    },
  },
}

export const LEAD_EVENT_OPS: Record<string, Op> = RAW
