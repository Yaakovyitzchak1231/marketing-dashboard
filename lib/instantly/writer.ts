/**
 * The ONLY code in this app that changes anything in Instantly, and only on a
 * human's confirmed click (server actions behind the login; never the agent
 * ops API, never a schedule).
 *
 * Exactly three calls are allowed, checked before anything leaves the box:
 *   POST /campaigns/{id}/pause     stop a campaign (Instantly v2)
 *   POST /campaigns/{id}/activate  start / resume a campaign
 *   POST /leads/add                add up to 1000 leads to a campaign
 * Anything else is refused. The read-only client (client.ts) stays read-only.
 *
 * Key: INSTANTLY_WRITE_API_KEY if set (a key with campaigns:update and
 * leads:create), else INSTANTLY_API_KEY. INSTANTLY_ACTIONS=off turns every
 * button and call off.
 *
 * Retries: only on 429 (Instantly said "not now", nothing happened). A network
 * error or 5xx on /leads/add is reported as "outcome unknown" and never resent
 * automatically, because Instantly may have taken it.
 */
import 'server-only'
import { INSTANTLY_BASE_URL } from '@/lib/instantly/client'

export type WriteKind = 'pause' | 'resume' | 'add_leads'

const UUIDISH = /^[0-9a-f-]{8,64}$/i

export function allowedWrite(path: string): boolean {
  return /^\/campaigns\/[0-9a-f-]{8,64}\/(pause|activate)$/i.test(path) || path === '/leads/add'
}

export class InstantlyWriteError extends Error {
  readonly status: number | null
  /** true when Instantly may have done it anyway (network error / 5xx). */
  readonly unknownOutcome: boolean
  constructor(message: string, status: number | null, unknownOutcome = false) {
    super(message)
    this.name = 'InstantlyWriteError'
    this.status = status
    this.unknownOutcome = unknownOutcome
  }
}

export interface AddLead {
  email: string
  first_name?: string | null
  last_name?: string | null
  company_name?: string | null
  website?: string | null
  phone?: string | null
  personalization?: string | null
  custom_variables?: Record<string, string | number | boolean | null>
}

export interface AddLeadsResult {
  status?: string
  total_sent?: number
  leads_uploaded?: number
  in_blocklist?: number
  duplicated_leads?: number
  skipped_count?: number
  invalid_email_count?: number
  [k: string]: unknown
}

export interface WriterOptions {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

function words(status: number, path: string, msg?: string): string {
  const d = msg ? ` (${msg.slice(0, 200)})` : ''
  if (status === 401) return 'Instantly rejected the API key. Check INSTANTLY_API_KEY.'
  if (status === 403)
    return `The Instantly key isn't allowed to make this change${d}. Give it campaigns:update and leads:create, or set INSTANTLY_WRITE_API_KEY to a key that has them.`
  if (status === 404) return `Instantly couldn't find that campaign${d}.`
  if (status === 402) return `Instantly said the plan doesn't allow this${d}.`
  if (status === 429) return 'Instantly is rate-limiting right now; nothing was changed. Try again in a minute.'
  return `Instantly refused ${path} (HTTP ${status})${d}.`
}

export class InstantlyWriter {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(o: WriterOptions) {
    if (!o.apiKey) throw new Error('InstantlyWriter needs an API key')
    this.apiKey = o.apiKey
    this.baseUrl = (o.baseUrl ?? INSTANTLY_BASE_URL).replace(/\/$/, '')
    this.fetchImpl = o.fetchImpl ?? fetch
    this.timeoutMs = o.timeoutMs ?? 30_000
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async pause(campaignId: string) {
    return this.post<Record<string, unknown>>(`/campaigns/${this.id(campaignId)}/pause`, undefined)
  }

  async resume(campaignId: string) {
    return this.post<Record<string, unknown>>(`/campaigns/${this.id(campaignId)}/activate`, undefined)
  }

  /** One call, at most 1000 leads. skip_if_in_workspace is always on: a lead already anywhere in Instantly is skipped, not duplicated. */
  async addLeads(campaignId: string, leads: AddLead[]) {
    if (leads.length === 0) throw new InstantlyWriteError('No leads to add.', null)
    if (leads.length > 1000) throw new InstantlyWriteError('Instantly takes at most 1000 leads per call.', null)
    return this.post<AddLeadsResult>('/leads/add', {
      campaign_id: this.id(campaignId),
      leads,
      skip_if_in_workspace: true,
      verify_leads_on_import: false,
    })
  }

  private id(v: string): string {
    if (!UUIDISH.test(v)) throw new InstantlyWriteError('That is not an Instantly campaign id.', null)
    return v
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (!allowedWrite(path)) throw new InstantlyWriteError(`Refusing to send ${path}: not one of the allowed Instantly changes.`, null)
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      let res: Response
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          cache: 'no-store',
        })
      } catch {
        clearTimeout(timer)
        throw new InstantlyWriteError(
          "Couldn't hear back from Instantly. It may or may not have made the change; check the campaign in Instantly before trying again.",
          null,
          true,
        )
      }
      clearTimeout(timer)
      const text = await res.text().catch(() => '')
      let json: unknown = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = null
      }
      if (res.ok) return (json ?? {}) as T
      const msg = json && typeof json === 'object' ? ((json as { message?: unknown; error?: unknown }).message ?? (json as { error?: unknown }).error) : undefined
      const clean = typeof msg === 'string' ? msg.split(this.apiKey).join('[redacted]') : undefined
      if (res.status === 429 && attempt < 2) {
        const ra = Number(res.headers.get('retry-after'))
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 1000 * 2 ** attempt)
        continue
      }
      if (res.status >= 500)
        throw new InstantlyWriteError(
          `Instantly had a server error (HTTP ${res.status}). It may or may not have made the change; check in Instantly before trying again.`,
          res.status,
          true,
        )
      throw new InstantlyWriteError(words(res.status, path, clean), res.status)
    }
    throw new InstantlyWriteError(words(429, path), 429)
  }
}

export function actionsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const off = (env.INSTANTLY_ACTIONS ?? '').trim().toLowerCase()
  if (off === 'off' || off === '0' || off === 'false') return false
  return Boolean((env.INSTANTLY_WRITE_API_KEY ?? env.INSTANTLY_API_KEY ?? '').trim())
}

export function writerFromEnv(env: Record<string, string | undefined> = process.env): InstantlyWriter | null {
  if (!actionsEnabled(env)) return null
  const key = (env.INSTANTLY_WRITE_API_KEY ?? '').trim() || (env.INSTANTLY_API_KEY ?? '').trim()
  return key ? new InstantlyWriter({ apiKey: key }) : null
}
