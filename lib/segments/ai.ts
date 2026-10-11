/**
 * "Describe it" (plan 2.11): text -> a segment definition, through the same
 * AI provider lib/campaign-profiles/suggest.ts uses (any OpenAI-compatible
 * chat endpoint, free/OSS only -- Yaakov's rule). Config is read DB-first
 * then env (lib/settings/store.ts resolveConfig, keys ai.base_url / ai.api_key
 * / ai.model) so a key saved on /settings works immediately.
 *
 * The model's output is NEVER applied blind: it goes through the exact same
 * validateDefinition() every other write goes through, so an invalid JSON
 * reply, an unknown field or an unknown operator comes back as a plain
 * error, never a silently-wrong segment.
 */
import 'server-only'
import { resolveConfig } from '../settings/store.ts'
import { DefinitionError, validateDefinition, type SegmentDefinition } from './definition.ts'
import { allFields } from './fields.ts'
import { readback } from './readback.ts'

export class SegmentAiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SegmentAiError'
  }
}

export interface SegmentAiConfig {
  baseUrl: string
  apiKey: string | null
  model: string
}

/** DB first (Settings -> AI group), env fallback (AI_BASE_URL / AI_API_KEY / AI_MODEL) --
 *  the same three keys lib/campaign-profiles/suggest.ts uses, read the modern way. */
export async function getSegmentAiConfig(): Promise<SegmentAiConfig | null> {
  const [baseUrl, apiKey, model] = await Promise.all([
    resolveConfig('ai.base_url'),
    resolveConfig('ai.api_key'),
    resolveConfig('ai.model'),
  ])
  if (!baseUrl.value || !model.value) return null
  return { baseUrl: baseUrl.value.replace(/\/+$/, ''), apiKey: apiKey.value, model: model.value }
}

export async function isSegmentAiConfigured(): Promise<boolean> {
  return (await getSegmentAiConfig()) !== null
}

function systemPrompt(): string {
  const fields = allFields()
    .map((f) => `- ${f.key} (${f.type}${f.table === 'contact' ? ', contact' : ', company'}${f.operators ? `, ops: ${f.operators.join('/')}` : ''})`)
    .join('\n')
  return `You turn one sentence describing a group of sales leads into a JSON segment definition for TapDash. \
Reply with ONLY a JSON object, no prose, no markdown fences, matching exactly this shape:
{
  "entity": "company" | "contact",
  "include": [ { "conditions": [ <condition>, ... ] }, ... ],
  "exclude": [ { "conditions": [ <condition>, ... ] }, ... ]
}
Groups in "include"/"exclude" are OR'd together; conditions inside one group are AND'd. "include": []
means "match everyone". A condition is one of:
- {"kind":"field","field":"<key>","op":"<op>","value":<value>,"value2":<value, "between" only>}
- {"kind":"event","event_type":"<type>","count_op":"eq|gt|gte|lt|lte","count":<n>,"within_last_days":<n?>}
- {"kind":"relative_date","field":"<date key>","op":"before|after","days":<n>,"compare_to":"<date key>?"}
- {"kind":"campaign_membership","mode":"in_campaign|any_active_campaign|never_contacted","campaign_id":<n?>}
- {"kind":"quality","op":"suppressed|not_suppressed|verified_sendable|not_verified_sendable"}
Registered fields (use ONLY these keys):
${fields}
Common event types: email_sent, email_opened, email_link_clicked, reply_received, auto_reply_received,
email_bounced, lead_unsubscribed, lead_interested, lead_not_interested, meeting_booked.
Pick "entity":"contact" for anything about a person's email activity (opens, clicks, replies); pick
"company" for anything about the account/lead itself (state, stage, pool). Never invent a field key
or event type not listed above. Output nothing but the JSON object.`
}

/** Strip ```json fences and leading/trailing prose around a JSON object, defensively --
 *  mirrors lib/campaign-profiles/suggest.ts's extractJson. */
export function extractJson(raw: string): unknown {
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first === -1 || last === -1 || last < first) throw new SegmentAiError('The AI reply had no JSON object in it.')
  const slice = s.slice(first, last + 1)
  try {
    return JSON.parse(slice)
  } catch (e) {
    throw new SegmentAiError(`The AI reply was not valid JSON (${e instanceof Error ? e.message : 'parse error'}).`)
  }
}

async function callChat(cfg: SegmentAiConfig, system: string, user: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new SegmentAiError(`The AI provider answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new SegmentAiError('The AI provider returned no message content.')
    return content
  } catch (e) {
    if (e instanceof SegmentAiError) throw e
    if (e instanceof Error && e.name === 'AbortError') throw new SegmentAiError('The AI provider did not answer within 60s.')
    throw new SegmentAiError(`Could not reach the AI provider: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    clearTimeout(timer)
  }
}

export type SegmentFromTextOutcome =
  | { configured: true; definition: SegmentDefinition; readback: string }
  | { configured: false; reason: string }

/**
 * "Describe it" -> a validated segment definition. `deps.chat` lets tests inject a
 * fake model reply (same shape as lib/campaign-profiles/suggest.ts's `deps.chat`).
 * Never returns an unvalidated definition: a bad reply throws SegmentAiError /
 * DefinitionError, which the caller (the ops wrapper / server action) turns into
 * a plain error for the person to see -- nothing is ever applied blind.
 */
export async function segmentFromText(
  text: string,
  deps: { chat?: typeof callChat; config?: SegmentAiConfig | null } = {},
): Promise<SegmentFromTextOutcome> {
  const input = typeof text === 'string' ? text.trim() : ''
  if (!input) throw new SegmentAiError('Describe who you want in plain English first.')
  const cfg = deps.config !== undefined ? deps.config : await getSegmentAiConfig()
  if (!cfg) return { configured: false, reason: 'no AI provider is configured' }
  const chat = deps.chat ?? callChat
  const content = await chat(cfg, systemPrompt(), input)
  const parsed = extractJson(content)
  let definition: SegmentDefinition
  try {
    definition = validateDefinition(parsed)
  } catch (e) {
    if (e instanceof DefinitionError) throw new SegmentAiError(`The AI reply did not describe a valid segment: ${e.message}`)
    throw e
  }
  return { configured: true, definition, readback: readback(definition) }
}
