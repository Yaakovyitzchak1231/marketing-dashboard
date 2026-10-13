/**
 * Outlook / Microsoft 365 mailbox through Microsoft Graph, read-only.
 *
 * Auth is the standard OAuth 2.0 authorization-code flow for a web app
 * (Microsoft identity platform v2), delegated permission Mail.Read only:
 *  - /api/mailbox/outlook/connect sends the owner to Microsoft's sign-in;
 *  - /api/mailbox/outlook/callback trades the code for a refresh token, which
 *    is saved encrypted in the settings store (lp.secrets), never in a file,
 *    log or browser;
 *  - reads trade the refresh token for a short-lived access token.
 * Nothing here can send, move, flag or delete mail: the scope cannot, and the
 * only Graph call is GET /me/messages.
 *
 * No SDK: plain fetch, injectable for tests (same shape as lib/seo/searchconsole.ts).
 */
import { directionOf, normalizeEmail } from './match.ts'
import type { MailboxMessage } from './types.ts'

/** Read-only. `openid profile email` only return who signed in (the id token); Mail.Read reads mail. */
export const OUTLOOK_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'https://graph.microsoft.com/Mail.Read'] as const

export interface OutlookAppConfig {
  clientId: string
  clientSecret: string
  /** 'common', 'organizations', or the directory (tenant) id. */
  tenant: string
}

export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>

export class OutlookError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'OutlookError'
    this.status = status
  }
}

const TENANT_RE = /^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9.-]+\.[a-z]{2,})$/i

export function validTenant(t: string): string | null {
  return TENANT_RE.test(t.trim()) ? null : 'Use "common", "organizations", or your directory (tenant) id.'
}

function tokenUrl(tenant: string): string {
  if (validTenant(tenant)) throw new OutlookError(`Not a valid Microsoft tenant: "${tenant}".`)
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant.trim())}/oauth2/v2.0`
}

export function authorizeUrl(cfg: OutlookAppConfig, redirectUri: string, state: string, loginHint?: string | null): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: OUTLOOK_SCOPES.join(' '),
    state,
    prompt: 'select_account',
  })
  if (loginHint) p.set('login_hint', loginHint)
  return `${tokenUrl(cfg.tenant)}/authorize?${p.toString()}`
}

async function readJson(r: { status: number; text(): Promise<string> }, what: string): Promise<Record<string, unknown>> {
  const t = await r.text()
  let j: Record<string, unknown> | null = null
  try {
    j = JSON.parse(t) as Record<string, unknown>
  } catch {
    /* not JSON */
  }
  if (r.status < 200 || r.status >= 300) {
    const err = j?.error as { message?: string; code?: string } | string | undefined
    const desc = typeof j?.error_description === 'string' ? j.error_description.split('\r\n')[0] : null
    const msg = desc ?? (typeof err === 'string' ? err : err?.message ?? err?.code ?? null)
    throw new OutlookError(`${what} answered HTTP ${r.status}${msg ? `: ${msg}` : ''}`, r.status)
  }
  if (!j) throw new OutlookError(`${what} did not answer with JSON.`)
  return j
}

export interface TokenSet {
  accessToken: string
  /** Microsoft usually rotates the refresh token on every use; null when it did not send one. */
  refreshToken: string | null
  expiresInSec: number
  /** From the id token (code exchange only): who signed in. */
  address: string | null
}

/** The address in an id token's payload (preferred_username / email). Signature not checked: it came straight from Microsoft's token endpoint over TLS. */
export function addressFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null
  const part = idToken.split('.')[1]
  if (!part) return null
  try {
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
    for (const k of ['email', 'preferred_username', 'upn']) {
      const e = normalizeEmail(typeof claims[k] === 'string' ? (claims[k] as string) : null)
      if (e) return e
    }
  } catch {
    /* fall through */
  }
  return null
}

function tokenSet(j: Record<string, unknown>, what: string): TokenSet {
  if (typeof j.access_token !== 'string' || !j.access_token) throw new OutlookError(`${what} returned no access token.`)
  const scope = typeof j.scope === 'string' ? j.scope.toLowerCase() : ''
  if (scope && !scope.split(' ').some((s) => s.endsWith('mail.read'))) {
    throw new OutlookError(`${what} did not grant Mail.Read (granted: ${scope}).`)
  }
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : null,
    expiresInSec: typeof j.expires_in === 'number' ? j.expires_in : Number(j.expires_in) || 3600,
    address: addressFromIdToken(j.id_token),
  }
}

export async function exchangeCode(cfg: OutlookAppConfig, code: string, redirectUri: string, fetcher: Fetcher = globalThis.fetch as unknown as Fetcher): Promise<TokenSet> {
  const r = await fetcher(`${tokenUrl(cfg.tenant)}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      scope: OUTLOOK_SCOPES.join(' '),
    }).toString(),
    signal: AbortSignal.timeout(20000),
  })
  return tokenSet(await readJson(r, 'Microsoft sign-in'), 'Microsoft sign-in')
}

export async function refreshAccess(cfg: OutlookAppConfig, refreshToken: string, fetcher: Fetcher = globalThis.fetch as unknown as Fetcher): Promise<TokenSet> {
  const r = await fetcher(`${tokenUrl(cfg.tenant)}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: OUTLOOK_SCOPES.filter((s) => s !== 'openid' && s !== 'profile' && s !== 'email').join(' '),
    }).toString(),
    signal: AbortSignal.timeout(20000),
  })
  return tokenSet(await readJson(r, 'Microsoft sign-in'), 'Microsoft sign-in')
}

interface GraphAddress {
  emailAddress?: { address?: string | null; name?: string | null } | null
}
export interface GraphMessage {
  id: string
  subject?: string | null
  from?: GraphAddress | null
  toRecipients?: GraphAddress[] | null
  ccRecipients?: GraphAddress[] | null
  sentDateTime?: string | null
  receivedDateTime?: string | null
  bodyPreview?: string | null
  webLink?: string | null
  conversationId?: string | null
  isDraft?: boolean | null
}

const addr = (a: GraphAddress | null | undefined) => a?.emailAddress?.address ?? null
const addrs = (l: GraphAddress[] | null | undefined) => (l ?? []).map(addr).filter((x): x is string => Boolean(x))

function safeWebLink(u: string | null | undefined): string | null {
  if (!u) return null
  try {
    const x = new URL(u)
    return x.protocol === 'https:' && /(^|\.)(office\.com|office365\.com|outlook\.com|microsoft\.com|live\.com|cloud\.microsoft)$/i.test(x.hostname) ? x.toString() : null
  } catch {
    return null
  }
}

/** One Graph message -> a MailboxMessage, or null when it is not 1:1 between `mailbox` and `lead`. */
export function toMailboxMessage(m: GraphMessage, mailbox: string, lead: string): MailboxMessage | null {
  const from = addr(m.from)
  const to = addrs(m.toRecipients)
  const cc = addrs(m.ccRecipients)
  const direction = directionOf({ from, to, cc, isDraft: m.isDraft }, mailbox, lead)
  if (!direction) return null
  const at = (direction === 'sent' ? m.sentDateTime : m.receivedDateTime) ?? m.receivedDateTime ?? m.sentDateTime
  if (!at || !m.id) return null
  return {
    provider: 'outlook',
    id: m.id,
    direction,
    subject: (m.subject ?? '').trim(),
    at,
    from: from ?? '',
    to,
    cc,
    preview: (m.bodyPreview ?? '').replace(/\s+/g, ' ').trim(),
    webLink: safeWebLink(m.webLink),
    conversationId: m.conversationId ?? null,
    matched: normalizeEmail(lead) ?? lead,
  }
}

const SELECT = 'id,subject,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,bodyPreview,webLink,conversationId,isDraft'

/** The Graph URL for every message (all folders) with `lead` as a participant. The address is validated first, so nothing else reaches the search. */
export function searchUrl(lead: string, limit: number): string {
  const e = normalizeEmail(lead)
  if (!e) throw new OutlookError('Not a valid email address.')
  const p = new URLSearchParams({ $search: `"participants:${e}"`, $select: SELECT, $top: String(Math.max(1, Math.min(limit, 250))) })
  return `https://graph.microsoft.com/v1.0/me/messages?${p.toString()}`
}

export async function messagesWith(
  accessToken: string,
  mailbox: string,
  lead: string,
  opts: { limit: number; fetcher?: Fetcher },
): Promise<{ messages: MailboxMessage[]; truncated: boolean }> {
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as Fetcher)
  const r = await fetcher(searchUrl(lead, opts.limit), {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  })
  const j = await readJson(r, 'Outlook')
  const value = Array.isArray(j.value) ? (j.value as GraphMessage[]) : []
  const messages = value.map((m) => toMailboxMessage(m, mailbox, lead)).filter((m): m is MailboxMessage => m !== null)
  return { messages, truncated: typeof j['@odata.nextLink'] === 'string' }
}
