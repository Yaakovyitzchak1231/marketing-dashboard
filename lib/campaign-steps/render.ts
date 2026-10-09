/**
 * Filling an email step for one lead, and the copy checks. Pure functions, no I/O.
 *
 * Placeholders are {{name}} (spaces allowed inside the braces, name matched without case).
 * A placeholder with no value and no fallback is left in the text as written, and the
 * preview flags it: an email must never go out with "{{firstName}}" in it.
 */

export type ValueSource = 'override' | 'lead' | 'enrichment' | 'fallback'

export interface ResolvedValue {
  /** The text that goes in, or null when there is nothing (no value, no fallback). */
  value: string | null
  source: ValueSource | null
  /** A real value (not the fallback): what Ready-personalized needs. */
  real: boolean
}

export interface Filled {
  text: string
  /** Placeholder names used, in order of first appearance (as written). */
  used: string[]
  /** Placeholders filled with the field's fallback text. */
  fallbacks: string[]
  /** Placeholders left as {{...}} in the output (no value, no fallback, or no such field). */
  leftovers: string[]
  /** Placeholders that name no personalization field at all. */
  unknown: string[]
}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g

export function placeholders(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(PLACEHOLDER)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** Fill {{name}} from values (keys matched case-insensitively). */
export function fillTemplate(text: string, values: Record<string, ResolvedValue>): Filled {
  const byLower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]))
  const used: string[] = []
  const fallbacks: string[] = []
  const leftovers: string[] = []
  const unknown: string[] = []
  const add = (list: string[], n: string) => {
    if (!list.includes(n)) list.push(n)
  }
  const out = text.replace(PLACEHOLDER, (whole, raw: string) => {
    const name = raw.trim()
    add(used, name)
    const v = name ? byLower.get(name.toLowerCase()) : undefined
    if (!v) {
      add(unknown, name)
      add(leftovers, name)
      return whole
    }
    if (v.value == null || v.value === '') {
      add(leftovers, name)
      return whole
    }
    if (v.source === 'fallback') add(fallbacks, name)
    return v.value
  })
  return { text: out, used, fallbacks, leftovers, unknown }
}

/** Any {{...}} still in a text (after filling). */
export function leftoverPlaceholders(text: string): string[] {
  return placeholders(text)
}

// ---------------------------------------------------------------- copy checks (warnings, never blockers)

export interface CopyWarning {
  code: 'has_link' | 'too_short' | 'too_long' | 'no_question' | 'leftover'
  message: string
}

export const WORDS_MIN = 55
export const WORDS_MAX = 80

const LINK = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|net|org|io|co|ai|shop|store|us|biz|info)(\/\S*)?\b/i

export function wordCount(text: string): number {
  const t = text.replace(PLACEHOLDER, ' x ').trim()
  return t ? t.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length : 0
}

/** Strip a trailing sign-off line or two ("Thanks,\nYaakov") is NOT done: the rule reads the body as written. */
export function endsWithQuestion(text: string): boolean {
  return /\?\s*["')\]]*\s*$/.test(text.trim())
}

/**
 * The jeweler copy rules, as warnings: no links, 55-80 words, ends with a question.
 * Run on the filled body (what the lead would read); leftovers are flagged too.
 */
export function copyChecks(body: string): CopyWarning[] {
  const w: CopyWarning[] = []
  const left = leftoverPlaceholders(body)
  if (left.length) w.push({ code: 'leftover', message: `Unfilled placeholder${left.length > 1 ? 's' : ''}: ${left.map((x) => `{{${x}}}`).join(', ')}` })
  if (LINK.test(body)) w.push({ code: 'has_link', message: 'Has a link. Jeweler emails should have no links.' })
  const n = wordCount(body)
  if (n < WORDS_MIN) w.push({ code: 'too_short', message: `${n} words. Aim for ${WORDS_MIN}-${WORDS_MAX}.` })
  else if (n > WORDS_MAX) w.push({ code: 'too_long', message: `${n} words. Aim for ${WORDS_MIN}-${WORDS_MAX}.` })
  if (body.trim() && !endsWithQuestion(body)) w.push({ code: 'no_question', message: 'Doesn\u2019t end with a question.' })
  return w
}
