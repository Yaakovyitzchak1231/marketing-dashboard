/**
 * Outbound notification mail over a provider's HTTPS API (no SMTP, no new dependency).
 * MAIL_PROVIDER = resend | brevo, MAIL_API_KEY, MAIL_FROM ("Dashboard <alerts@example.com>").
 * Both have free tiers (Resend 3,000/month; Brevo 300/day). Unset = the email is HELD
 * (status 'held', "waiting for mail settings" on the row, no attempt spent) and goes out
 * within minutes of the settings being added.
 */
export interface MailInput {
  to: string
  subject: string
  text: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Resolves the three mail settings (settings DB first, env fallback),
 * following the same pattern as lib/instantly/client.ts's clientFromConfig. */
async function readMailConfig(env: Record<string, string | undefined>) {
  const { resolveConfig } = await import('../settings/store.ts')
  const [{ value: provider }, { value: key }, { value: from }] = await Promise.all([
    resolveConfig('mail.provider', env),
    resolveConfig('mail.api_key', env),
    resolveConfig('mail.from', env),
  ])
  return { provider: provider || undefined, key: key || undefined, from: from || undefined }
}

/** Settings-aware variant. Returns true if all three mail settings resolve
 * (from the settings DB first, then env). */
export async function mailConfiguredAsync(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const { provider, key, from } = await readMailConfig(env)
  return Boolean(provider && key && from)
}

/** Synchronous convenience for callers that already know settings are present
 * (or that want the env-only fast-path). Kept synchronous by reading env first;
 * if a caller wants the settings DB, use mailConfiguredAsync instead. */
export function mailConfigured(env = process.env): boolean {
  return Boolean(env.MAIL_PROVIDER && env.MAIL_API_KEY && env.MAIL_FROM)
}

function parseFrom(from: string): { email: string; name?: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from)
  return m ? { name: m[1].replace(/^"|"$/g, '') || undefined, email: m[2] } : { email: from.trim() }
}

export const MAIL_NOT_CONFIGURED = 'waiting for mail settings (MAIL_PROVIDER, MAIL_API_KEY, MAIL_FROM)'

export type MailResult = { ok: true; id?: string } | { ok: false; error: string; retry: boolean; unconfigured?: true }

/**
 * "Not configured" is NOT a failure: the caller holds the email (no attempt spent) and
 * sends it once the settings exist, so nothing queued before setup is lost.
 * Settings are resolved through the settings store (DB first, env fallback) the same way
 * lib/instantly/client.ts's clientFromConfig does, so a value saved on /settings takes
 * effect immediately.
 */
export async function sendMail(m: MailInput, fetchImpl: FetchLike = fetch, env = process.env): Promise<MailResult> {
  const { provider, key, from } = await readMailConfig(env)
  if (!provider || !key || !from) return { ok: false, error: MAIL_NOT_CONFIGURED, retry: true, unconfigured: true }
  const providerL = provider.toLowerCase()
  let res: Response
  try {
    if (providerL === 'resend') {
      res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [m.to], subject: m.subject.slice(0, 250), text: m.text }),
        signal: AbortSignal.timeout(10_000),
      })
    } else if (providerL === 'brevo') {
      const f = parseFrom(from)
      res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: f, to: [{ email: m.to }], subject: m.subject.slice(0, 250), textContent: m.text }),
        signal: AbortSignal.timeout(10_000),
      })
    } else {
      return { ok: false, error: `unknown MAIL_PROVIDER '${provider}' (use resend or brevo)`, retry: false }
    }
  } catch (e) {
    return { ok: false, error: `mail provider unreachable: ${(e as Error).message}`.slice(0, 300), retry: true }
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) return { ok: false, error: `${providerL} answered ${res.status}: ${text.slice(0, 200)}`, retry: res.status >= 500 || res.status === 429 }
  let id: string | undefined
  try {
    const j = JSON.parse(text) as { id?: string; messageId?: string }
    id = j.id ?? j.messageId
  } catch {
    /* no id */
  }
  return { ok: true, id }
}
