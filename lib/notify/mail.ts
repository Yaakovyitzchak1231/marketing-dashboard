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
 */
export async function sendMail(m: MailInput, fetchImpl: FetchLike = fetch, env = process.env): Promise<MailResult> {
  if (!mailConfigured(env)) return { ok: false, error: MAIL_NOT_CONFIGURED, retry: true, unconfigured: true }
  const provider = String(env.MAIL_PROVIDER).toLowerCase()
  const key = String(env.MAIL_API_KEY)
  const from = String(env.MAIL_FROM)
  let res: Response
  try {
    if (provider === 'resend') {
      res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [m.to], subject: m.subject.slice(0, 250), text: m.text }),
        signal: AbortSignal.timeout(10_000),
      })
    } else if (provider === 'brevo') {
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
  if (!res.ok) return { ok: false, error: `${provider} answered ${res.status}: ${text.slice(0, 200)}`, retry: res.status >= 500 || res.status === 429 }
  let id: string | undefined
  try {
    const j = JSON.parse(text) as { id?: string; messageId?: string }
    id = j.id ?? j.messageId
  } catch {
    /* no id */
  }
  return { ok: true, id }
}
