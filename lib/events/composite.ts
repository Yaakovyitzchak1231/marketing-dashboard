/**
 * Composite event rules: events derived from a combination of underlying
 * events, not from any single source. Rules are data (COMPOSITE_RULES), so
 * adding one is adding an entry — no new branches, no deploy-time wiring.
 *
 * A rule fires at most once per lead (dedupe_key
 * `composite:<type>:contact:<id>` / `composite:<type>:company:<id>`): the
 * composite is a state the lead reached ("replied positively"), not a
 * recurring tick. The underlying events still record every re-engagement.
 *
 * Evaluation is explicit, never inside emitLeadEvent: the ingress points
 * (ops track_event/track_events, the Instantly webhook, the site-events
 * webhook) call evaluateCompositeRules after a successful insert. A composite
 * emission goes through emitLeadEvent directly, so there is no recursion.
 */
import type { Queryable } from '@/lib/db/types'
import { emitLeadEvent, EventError, type EmitResult } from './emit'

export interface CompositeRule {
  /** The derived event type to emit (must be registered in lp.event_types). */
  type: string
  /** Plain-English description, shown wherever rules are listed. */
  description: string
  /**
   * Pure: does this rule fire for the just-emitted event type, given the
   * lead's event history (type strings, newest first, including the
   * just-emitted event)?
   */
  fires: (emittedType: string, history: string[]) => boolean
}

export const COMPOSITE_RULES: CompositeRule[] = [
  {
    type: 'positive_reply',
    description: 'The lead replied and was marked interested (or booked a meeting) — the reply that matters.',
    fires: (t, h) =>
      (t === 'lead_interested' || t === 'meeting_booked') && h.includes('reply_received') ||
      (t === 'reply_received' && (h.includes('lead_interested') || h.includes('meeting_booked'))),
  },
]

export interface EmittedEventRef {
  id: number
  type: string
  company_id: number | null
  contact_id: number | null
  campaign_id?: number | null
  instantly_campaign_id?: string | null
}

export interface CompositeEvaluation {
  rule: string
  fired: boolean
  inserted: boolean
  id: number | null
  error?: string
}

/**
 * Evaluate every composite rule against a just-emitted event. Returns one
 * result per rule that fired (fired:false rules are omitted). A rule whose
 * type is not registered is skipped with an error in its result — a
 * misconfigured rule must never break the ingestion of the underlying event.
 */
export async function evaluateCompositeRules(q: Queryable, emitted: EmittedEventRef): Promise<CompositeEvaluation[]> {
  const scopeCol = emitted.contact_id != null ? 'contact_id' : emitted.company_id != null ? 'company_id' : null
  if (!scopeCol) return []
  const scopeVal = (emitted.contact_id ?? emitted.company_id) as number
  const { rows } = await q.query<{ type: string }>(
    `select type from lp.lead_events where ${scopeCol} = $1 order by occurred_at desc, id desc limit 200`,
    [scopeVal],
  )
  const history = rows.map((r) => r.type)
  const out: CompositeEvaluation[] = []
  for (const rule of COMPOSITE_RULES) {
    let fires = false
    try {
      fires = rule.fires(emitted.type, history)
    } catch {
      fires = false
    }
    if (!fires) continue
    const dedupe_key = `composite:${rule.type}:${scopeCol}:${scopeVal}`
    try {
      const r: EmitResult = await emitLeadEvent(q, {
        type: rule.type,
        company_id: emitted.company_id,
        contact_id: emitted.contact_id,
        campaign_id: emitted.campaign_id ?? null,
        instantly_campaign_id: emitted.instantly_campaign_id ?? null,
        source: 'composite_rule',
        occurred_at: new Date(),
        dedupe_key,
        props: {
          rule: rule.type,
          triggered_by_event_id: emitted.id,
          triggered_by_type: emitted.type,
        },
      })
      out.push({ rule: rule.type, fired: true, inserted: r.inserted, id: r.id })
    } catch (e) {
      // Unknown/unregistered composite type (or any other emit problem):
      // record it, don't break the caller.
      out.push({
        rule: rule.type,
        fired: true,
        inserted: false,
        id: null,
        error: e instanceof EventError ? e.message : (e as Error).message || String(e),
      })
    }
  }
  return out
}
