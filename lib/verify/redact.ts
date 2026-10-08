/**
 * Keys never leave the process: not in logs, not in stored raw payloads, not
 * in error text. Every raw payload and URL that might be persisted or shown
 * goes through these.
 */

const KEY_PARAMS = /([?&](?:api|api_key|apikey|key)=)[^&#\s]*/gi

/** Replace the value of any api/api_key/key query parameter. */
export function redactUrl(url: string): string {
  return url.replace(KEY_PARAMS, '$1REDACTED')
}

/** Remove every occurrence of the given secrets from a string. */
export function redactText(text: string, secrets: (string | null | undefined)[]): string {
  let out = redactUrl(text)
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('REDACTED')
  }
  return out
}

/**
 * Deep-copy a JSON value with secrets removed: drops key-ish fields and
 * scrubs any string that contains a secret.
 */
export function redactRaw<T>(value: T, secrets: (string | null | undefined)[]): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactText(v, secrets)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (/^(api|api_key|apikey|key|token|secret)$/i.test(k)) {
          out[k] = 'REDACTED'
        } else {
          out[k] = walk(val)
        }
      }
      return out
    }
    return v
  }
  return walk(value) as T
}
