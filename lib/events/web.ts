/**
 * Site emitters for the lead event stream: page_visited and form_submitted
 * (lp.event_types, category 'web', source 'site'). The site's own backend —
 * server-side only, never browser JavaScript (see the SERVER-TO-SERVER note
 * on POST /api/webhooks/site-events) — posts to that webhook, which validates
 * and calls these; agents can also emit through the ops track_event API. Both
 * resolve the lead the same way every other emitter does (company_id /
 * contact_id / email via emitLeadEvent).
 *
 * Client-supplied dedupe_keys are prefixed server-side (`site:<type>:<key>`)
 * because lp.lead_events.dedupe_key is globally unique: without the prefix a
 * caller could squat (or collide with) another namespace's keys, e.g. an
 * Instantly webhook key, and silently break deduplication for that event.
 *
 * Form field VALUES are never stored — only which form was submitted and the
 * page it was on. PII belongs in the lead record, not the event stream, so
 * query strings and fragments are stripped from stored urls/referrers.
 */
import type { Queryable } from '@/lib/db/types'
import { emitLeadEvent, EventError, type EmitResult } from './emit'

export interface WebEventInput {
  company_id?: number | null
  contact_id?: number | null
  /** Used to resolve company/contact when no ids are given; stored as email_norm. */
  email?: string | null
  campaign_id?: number | null
  url?: string | null
  page_title?: string | null
  referrer?: string | null
  occurred_at?: Date | string | null
  dedupe_key?: string | null
}

export interface FormSubmittedInput extends WebEventInput {
  form_id?: string | null
  form_name?: string | null
}

function cleanUrl(u: string | null | undefined): string | null {
  const s = (u ?? '').trim()
  if (!s) return null
  try {
    const parsed = new URL(s)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    // Strip the query string and fragment: they routinely carry PII
    // (?email=..., reset tokens, UTM) that must not land in the event stream.
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().slice(0, 2000)
  } catch {
    return null
  }
}

const txt = (v: string | null | undefined, max: number): string | null => {
  const s = (v ?? '').trim()
  return s ? s.slice(0, max) : null
}

function webProps(input: WebEventInput): Record<string, unknown> {
  const url = cleanUrl(input.url)
  const pageTitle = txt(input.page_title, 300)
  const referrer = cleanUrl(input.referrer)
  return {
    ...(url ? { url } : {}),
    ...(pageTitle ? { page_title: pageTitle } : {}),
    ...(referrer ? { referrer } : {}),
  }
}

/**
 * Prefix a client-supplied dedupe_key with the site namespace so it can never
 * collide with (or squat) another namespace's globally-unique dedupe_key.
 * Deterministic: retrying with the same key stays idempotent.
 */
function prefixDedupeKey(type: 'page_visited' | 'form_submitted', key: string | null | undefined): string | null {
  const k = (key ?? '').trim()
  return k ? `site:${type}:${k}` : null
}

function webBase(type: 'page_visited' | 'form_submitted', input: WebEventInput) {
  return {
    company_id: input.company_id ?? null,
    contact_id: input.contact_id ?? null,
    email: input.email ?? null,
    campaign_id: input.campaign_id ?? null,
    source: 'site',
    occurred_at: input.occurred_at ?? null,
    dedupe_key: prefixDedupeKey(type, input.dedupe_key),
  }
}

/** Someone loaded a page on the site. At least a url or an identity is expected, but neither is hard-required. */
export async function emitPageVisited(q: Queryable, input: WebEventInput): Promise<EmitResult> {
  return emitLeadEvent(q, { ...webBase('page_visited', input), type: 'page_visited', props: webProps(input) })
}

/**
 * Someone submitted a form on the site. form_id or form_name is required —
 * a submission that doesn't say which form is useless downstream.
 */
export async function emitFormSubmitted(q: Queryable, input: FormSubmittedInput): Promise<EmitResult> {
  const formId = txt(input.form_id, 120)
  const formName = txt(input.form_name, 120)
  if (!formId && !formName) throw new EventError('form_id or form_name is required for a form_submitted event')
  return emitLeadEvent(q, {
    ...webBase('form_submitted', input),
    type: 'form_submitted',
    props: { ...webProps(input), ...(formId ? { form_id: formId } : {}), ...(formName ? { form_name: formName } : {}) },
  })
}
