/**
 * Instant delivery: every lp.notifications row gets one lp.deliveries row per channel of
 * its recipient (a trigger does that, in the same transaction). This module moves those
 * rows forward:
 *
 *   push channels   webhook  signed POST to the agent's URL      -> delivered on 2xx
 *                   email    provider HTTPS API                  -> sent (delivered when the agent acks)
 *                   ntfy     wake-up ping to a private topic     -> sent (delivered when the agent acks)
 *                   relay    ping the carrying agent (e.g. Hermes sends Yaakov a WhatsApp)
 *   fetch channels  pull / stream / mcp: the agent reads its feed and acks.
 *
 * Retries with backoff; after MAX_ATTEMPTS a row is "failed" with the reason, and the UI
 * shows it on the task. People's pushes wait out Shabbos ("held") when they asked for it.
 * dispatchDue() is called right after every write (lib/notify/kick.ts, Next's after()),
 * after feed reads and in open stream loops. For unattended retries, configure
 * a scheduler to call /api/ops/deliveries/dispatch; traffic alone is not reliable.
 */
import { createHmac, randomBytes } from 'node:crypto'
import type { Db, Queryable } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { mailConfigured, sendMail, MAIL_NOT_CONFIGURED, type FetchLike } from './mail.ts'
import { shabbosEndsAt } from './shabbos.ts'

export const CHANNEL_KINDS = ['webhook', 'ntfy', 'email', 'stream', 'pull', 'mcp', 'relay'] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]
const PUSH_KINDS: ChannelKind[] = ['webhook', 'email', 'ntfy', 'relay']
const FETCH_KINDS: ChannelKind[] = ['ntfy', 'stream', 'pull', 'mcp']
export const MAX_ATTEMPTS = 8
// Two waves of five, with at most 12 seconds of network work per delivery.
// This leaves headroom under a 60-second route and the 90-second claim lease.
export const MAX_DISPATCH_BATCH = 10
const DISPATCH_CONCURRENCY = 5
const DELIVERY_TIMEOUT_MS = 12_000
const BACKOFF_S = [10, 30, 120, 600, 1800, 3600, 7200, 14400]
const REPING_S = 300
/** How often an email held for missing mail settings is looked at again (no attempt spent). */
export const MAIL_HOLD_RECHECK_S = 300

export function backoffSeconds(attempts: number): number {
  return BACKOFF_S[Math.min(Math.max(attempts - 1, 0), BACKOFF_S.length - 1)]
}

export function dashboardUrl(env = process.env): string {
  const u = env.DASHBOARD_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
  return u.replace(/\/+$/, '')
}

// ------------------------------------------------------------------ event payload

export interface DeliveryEvent {
  type: 'notification'
  delivery_id: number
  notification_id: number
  kind: string
  recipient: string
  recipient_name: string
  from: string | null
  from_name: string | null
  /** 'human' | 'agent' (null when the sender is unknown). Agents use it to never auto-reply to an agent. */
  from_kind: string | null
  summary: string
  body: string | null
  task: { id: number; title: string; kind: string; status: string; url: string } | null
  comment_id: number | null
  created_at: string
  /** Set when another agent carries this to a person (e.g. a WhatsApp to Yaakov). */
  relay: { target: string; to: string | null; text: string } | null
  ack: { method: 'POST'; url: string; body: { ids: number[] } }
}

interface DeliveryJoin {
  id: number
  notification_id: number
  channel_id: number
  recipient: string
  via: string | null
  status: string
  attempts: number
  kind: ChannelKind
  config: Record<string, unknown>
  secret: string | null
  n_kind: string
  summary: string
  body: string | null
  task_id: number | null
  comment_id: number | null
  created_by: string | null
  n_created_at: Date
  recipient_name: string
  recipient_kind: string
  quiet_shabbos: boolean
  from_name: string | null
  from_kind: string | null
  task_title: string | null
  task_kind: string | null
  task_status: string | null
}

const JOIN = `
  select d.id, d.notification_id, d.channel_id, d.recipient, d.via, d.status, d.attempts,
         c.kind, c.config, c.secret,
         n.kind as n_kind, n.summary, n.body, n.task_id, n.comment_id, n.created_by, n.created_at as n_created_at,
         r.display_name as recipient_name, r.kind as recipient_kind, r.quiet_shabbos,
         f.display_name as from_name, f.kind as from_kind,
         t.title as task_title, t.kind as task_kind, t.status as task_status
    from lp.deliveries d
    join lp.delivery_channels c on c.id = d.channel_id
    join lp.notifications n on n.id = d.notification_id
    join lp.actors r on r.id = d.recipient
    left join lp.actors f on f.id = n.created_by
    left join lp.tasks t on t.id = n.task_id`

export function toEvent(r: DeliveryJoin, base = dashboardUrl()): DeliveryEvent {
  const relay =
    r.kind === 'relay'
      ? {
          target: String(r.config.target ?? 'whatsapp'),
          to: r.config.to == null ? null : String(r.config.to),
          text: `${r.summary}${r.body && r.n_kind === 'message' ? `\n\n${r.body.slice(0, 1500)}` : ''}${r.task_id ? `\n${base}/team/${r.task_id}` : ''}`,
        }
      : null
  return {
    type: 'notification',
    delivery_id: r.id,
    notification_id: r.notification_id,
    kind: r.n_kind,
    recipient: r.recipient,
    recipient_name: r.recipient_name,
    from: r.created_by,
    from_name: r.from_name,
    from_kind: r.from_kind ?? null,
    summary: r.summary,
    body: r.body,
    task: r.task_id
      ? { id: r.task_id, title: r.task_title ?? '', kind: r.task_kind ?? '', status: r.task_status ?? '', url: `${base}/team/${r.task_id}` }
      : null,
    comment_id: r.comment_id,
    created_at: new Date(r.n_created_at).toISOString(),
    relay,
    ack: { method: 'POST', url: `${base}/api/ops/feed/ack`, body: { ids: [r.id] } },
  }
}

// ------------------------------------------------------------------ signing

/** Webhook signature: hex HMAC-SHA256 over `${timestamp}.${body}` with the channel secret. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

export function newSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`
}

// ------------------------------------------------------------------ dispatch (push)

async function settle(
  q: Queryable,
  id: number,
  channelId: number,
  outcome: { status: 'sent' | 'delivered'; nextAt?: Date } | { error: string; retry: boolean; attempts: number },
  now: Date = new Date(),
) {
  if ('status' in outcome) {
    await q.query(
      `update lp.deliveries set status = $2, sent_at = coalesce(sent_at, now()),
              delivered_at = case when $2 = 'delivered' then now() else delivered_at end,
              next_attempt_at = $3, last_error = null, updated_at = now() where id = $1 and delivered_at is null`,
      [id, outcome.status, outcome.nextAt ?? now],
    )
    await q.query('update lp.delivery_channels set last_ok_at = now() where id = $1', [channelId])
    return
  }
  const final = !outcome.retry || outcome.attempts >= MAX_ATTEMPTS
  const settled = await q.query(
    `update lp.deliveries set status = $2, last_error = $3, failed_at = case when $2 = 'failed' then now() else failed_at end,
            next_attempt_at = $4::timestamptz + ($5 || ' seconds')::interval, updated_at = now() where id = $1 and delivered_at is null returning id`,
    [id, final ? 'failed' : 'pending', outcome.error.slice(0, 500), now, String(backoffSeconds(outcome.attempts))],
  )
  if (!settled.rows.length) return // the recipient may have acknowledged while the push was in flight
  await q.query('update lp.delivery_channels set last_error = $2, last_error_at = now() where id = $1', [channelId, outcome.error.slice(0, 500)])
  if (final) {
    const w = await q.query<{ name: string; kind: string; task_id: number | null }>(
      `select a.display_name as name, c.kind, n.task_id from lp.deliveries d join lp.actors a on a.id = d.recipient
         join lp.delivery_channels c on c.id = d.channel_id join lp.notifications n on n.id = d.notification_id where d.id = $1`,
      [id],
    )
    const who = w.rows[0] ? `${w.rows[0].name} (${w.rows[0].kind})` : 'someone'
    await q.query(
      `insert into lp.events (actor, kind, summary, entity_type, entity_id, task_id, data) values ('system', 'delivery.failed', $1, 'delivery', $2, $3, $4)`,
      [`Could not reach ${who}: ${outcome.error.slice(0, 200)}`, String(id), w.rows[0]?.task_id ?? null, JSON.stringify({ channel_id: channelId })],
    )
  }
}

async function ntfyPing(fetchImpl: FetchLike, config: Record<string, unknown>, deliveryId: number, signal: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
  const server = String(config.server || 'https://ntfy.sh').replace(/\/+$/, '')
  const topic = String(config.topic || '')
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(topic)) return { ok: false, error: 'ntfy topic missing or too guessable' }
  try {
    // The ping carries only an id; the event itself is read from the dashboard with the agent's key.
    const res = await fetchImpl(`${server}/${topic}`, { method: 'POST', body: JSON.stringify({ d: deliveryId }), signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]), redirect: 'manual' })
    return res.ok ? { ok: true } : { ok: false, error: `ntfy answered ${res.status}` }
  } catch (e) {
    return { ok: false, error: `ntfy unreachable: ${(e as Error).message}` }
  }
}

export interface DispatchResult {
  picked: number
  sent: number
  delivered: number
  held: number
  retrying: number
  failed: number
}

/**
 * Move every due push delivery one step. Safe to call from many places at once:
 * rows are claimed FOR UPDATE SKIP LOCKED with a short in-flight lease.
 */
export async function dispatchDue(db: Db, opts: { fetchImpl?: FetchLike; now?: Date; limit?: number; env?: NodeJS.ProcessEnv } = {}): Promise<DispatchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? new Date()
  const out: DispatchResult = { picked: 0, sent: 0, delivered: 0, held: 0, retrying: 0, failed: 0 }
  const limit = Number.isFinite(opts.limit) ? Math.min(MAX_DISPATCH_BATCH, Math.max(1, Math.trunc(opts.limit!))) : MAX_DISPATCH_BATCH
  const claimed = await db.tx(async (q) => {
    const { rows } = await q.query<{ id: number }>(
      `select d.id from lp.deliveries d join lp.delivery_channels c on c.id = d.channel_id
        where c.enabled and c.kind = any($1) and d.next_attempt_at <= $2
          and (d.status in ('pending', 'held') or (d.status = 'sent' and c.kind in ('ntfy', 'relay') and d.delivered_at is null))
        order by d.id limit $3 for update of d skip locked`,
      [PUSH_KINDS, now, limit],
    )
    if (!rows.length) return []
    const ids = rows.map((r) => r.id)
    await q.query(`update lp.deliveries set attempts = attempts + 1, next_attempt_at = $2::timestamptz + interval '90 seconds', updated_at = now() where id = any($1)`, [ids, now])
    const j = await q.query<DeliveryJoin>(`${JOIN} where d.id = any($1) order by d.id`, [ids])
    return j.rows
  })
  out.picked = claimed.length
  const base = dashboardUrl(opts.env)
  async function deliver(r: DeliveryJoin) {
    const deadline = AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
    // Recheck just before sending: a channel may have been disabled after claim.
    const channel = await db.query<{ enabled: boolean }>(
      'select c.enabled from lp.delivery_channels c join lp.deliveries d on d.channel_id = c.id where d.id = $1 and d.delivered_at is null', [r.id],
    )
    if (!channel.rows[0]?.enabled) return
    // People who keep Shabbos: hold pushes to their phone until nightfall.
    if (r.recipient_kind === 'human' && r.quiet_shabbos) {
      const end = shabbosEndsAt(now)
      if (end) {
        await db.query(`update lp.deliveries set status = 'held', attempts = greatest(attempts - 1, 0), next_attempt_at = $2, updated_at = now() where id = $1 and delivered_at is null`, [r.id, end])
        out.held++
        return
      }
    }
    const ev = toEvent(r, base)
    if (r.kind === 'webhook') {
      const url = String(r.config.url ?? '')
      if (!/^https:\/\//.test(url)) {
        await settle(db, r.id, r.channel_id, { error: 'webhook URL must start with https://', retry: false, attempts: r.attempts }, now)
        out.failed++
        return
      }
      const body = JSON.stringify(ev)
      const ts = String(Math.floor(now.getTime() / 1000))
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'user-agent': 'marketing-dashboard-delivery/1',
        'x-dashboard-event': `notification.${r.n_kind}`,
        'x-dashboard-delivery': String(r.id),
        'x-dashboard-timestamp': ts,
      }
      if (r.secret) headers['x-dashboard-signature'] = `sha256=${signWebhook(r.secret, ts, body)}`
      let res: Response | null = null
      let err = ''
      try {
        res = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(8_000) })
      } catch (e) {
        err = `unreachable: ${(e as Error).message}`
      }
      if (res && res.ok) {
        await settle(db, r.id, r.channel_id, { status: 'delivered' }, now)
        out.delivered++
      } else {
        const retry = !res || res.status >= 500 || res.status === 429 || res.status === 408
        const attempts = r.attempts
        await settle(db, r.id, r.channel_id, { error: err || `answered ${res!.status}`, retry, attempts }, now)
        if (!retry || attempts >= MAX_ATTEMPTS) out.failed++
        else out.retrying++
      }
      return
    }
    if (r.kind === 'email') {
      if (!mailConfigured(opts.env)) {
        // Not a failure: hold it without spending an attempt; it goes out once MAIL_* exist.
        await db.query(
          `update lp.deliveries set status = 'held', attempts = greatest(attempts - 1, 0), last_error = $3,
                  next_attempt_at = $2::timestamptz + ($4 || ' seconds')::interval, updated_at = now() where id = $1 and delivered_at is null`,
          [r.id, now, MAIL_NOT_CONFIGURED, String(MAIL_HOLD_RECHECK_S)],
        )
        out.held++
        return
      }
      const to = String(r.config.to ?? '')
      const m = await sendMail({ to, subject: `[Dashboard] ${ev.summary}`, text: mailText(ev) }, fetchImpl, opts.env)
      if (m.ok) {
        await settle(db, r.id, r.channel_id, { status: 'sent' }, now)
        out.sent++
      } else {
        const attempts = r.attempts
        await settle(db, r.id, r.channel_id, { error: m.error, retry: m.retry, attempts }, now)
        if (!m.retry || attempts >= MAX_ATTEMPTS) out.failed++
        else out.retrying++
      }
      return
    }
    // ntfy (own channel) or relay (ping the carrying agent's ntfy channels).
    const attempts = r.attempts
    if (r.status === 'sent' && attempts > MAX_ATTEMPTS) {
      await settle(db, r.id, r.channel_id, { error: `${r.via ?? r.recipient} never picked it up`, retry: false, attempts }, now)
      out.failed++
      return
    }
    let targets: Record<string, unknown>[] = []
    if (r.kind === 'ntfy') targets = [r.config]
    else if (r.via) {
      const c = await db.query<{ config: Record<string, unknown> }>(`select config from lp.delivery_channels where actor_id = $1 and kind = 'ntfy' and enabled`, [r.via])
      targets = c.rows.map((x) => x.config)
    }
    if (r.kind === 'relay' && !r.via) {
      await settle(db, r.id, r.channel_id, { error: 'relay channel has no carrying agent (config.via)', retry: false, attempts }, now)
      out.failed++
      return
    }
    let okAny = targets.length === 0 // a relay agent without ntfy still finds it in its feed
    let lastErr = ''
    for (const t of targets) {
      if (deadline.aborted) {
        lastErr = 'relay wake-up deadline exceeded'
        break
      }
      const p = await ntfyPing(fetchImpl, t, r.id, deadline)
      if (p.ok) okAny = true
      else lastErr = p.error
    }
    if (okAny) {
      await settle(db, r.id, r.channel_id, { status: 'sent', nextAt: new Date(now.getTime() + REPING_S * 1000) }, now)
      out.sent++
    } else {
      await settle(db, r.id, r.channel_id, { error: lastErr, retry: true, attempts }, now)
      if (attempts >= MAX_ATTEMPTS) out.failed++
      else out.retrying++
    }
  }
  let next = 0
  const workers = await Promise.allSettled(Array.from({ length: Math.min(DISPATCH_CONCURRENCY, claimed.length) }, async () => {
    while (next < claimed.length) await deliver(claimed[next++])
  }))
  if (workers.some((r) => r.status === 'rejected')) throw new Error('A delivery worker failed; unsettled rows remain queued for retry.')
  return out
}

export function mailText(ev: DeliveryEvent): string {
  const lines = [ev.summary, '']
  if (ev.body) lines.push(ev.body.slice(0, 8000), '')
  if (ev.task) lines.push(`Task #${ev.task.id}: ${ev.task.title} (${ev.task.kind}, ${ev.task.status})`, ev.task.url, '')
  lines.push(
    'To act on it, use the dashboard ops API with your agent key:',
    ev.task ? `  POST /api/ops {"op":"claim_task","task_id":${ev.task.id}}` : '  GET /api/ops/feed',
    `  POST /api/ops/feed/ack {"ids":[${ev.delivery_id}]}   (marks this delivered)`,
    '',
    '--- event (JSON) ---',
    JSON.stringify(ev),
  )
  return lines.join('\n')
}

// ------------------------------------------------------------------ feed (fetch channels)

/**
 * What an agent has not acknowledged yet: notifications for it (on a fetchable channel,
 * or any of its notifications when it has no channel at all), plus relay items it carries
 * for someone else. Returned items are marked sent; unacked items come back after 2 minutes.
 */
export async function feed(db: Db, actor: string, opts: { after_id?: number | null; limit?: number; now?: Date } = {}): Promise<DeliveryEvent[]> {
  const now = opts.now ?? new Date()
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200)
  const rows = await db.tx(async (q) => {
    // Serialize feeds for this actor, including sibling channels of one notification.
    await q.query('select id from lp.actors where id = $1 for update', [actor])
    const { rows } = await q.query<DeliveryJoin>(
      `${JOIN}
        where c.enabled and ((d.recipient = $1 and c.kind = any($2) and d.status in ('pending', 'sent'))
            or (d.via = $1 and c.kind = 'relay' and d.status = 'sent'))
          and d.delivered_at is null
          and (d.fetched_at is null or d.fetched_at < $3::timestamptz - interval '2 minutes')
          and ($4::bigint is null or d.id > $4)
        order by d.id limit $5`,
      [actor, FETCH_KINDS, now, opts.after_id ?? null, limit * 2],
    )
    // One item per notification for the agent itself (it may have both ntfy and pull).
    const seen = new Set<number>()
    const pick = rows.filter((r) => {
      if (r.via === actor) return true
      if (seen.has(r.notification_id)) return false
      seen.add(r.notification_id)
      return true
    }).slice(0, limit)
    if (pick.length) {
      await q.query(
        `update lp.deliveries set fetched_at = $2, status = case when status = 'pending' then 'sent' else status end,
                sent_at = coalesce(sent_at, $2), updated_at = now()
          where delivered_at is null and status in ('pending', 'sent')
            and (id = any($1) or (recipient = $3 and notification_id = any($4)
              and channel_id in (select id from lp.delivery_channels where enabled and kind = any($5))))`,
        [pick.map((r) => r.id), now, actor, pick.filter((r) => r.recipient === actor).map((r) => r.notification_id), FETCH_KINDS],
      )
    }
    return pick
  })
  return rows.map((r) => toEvent(r))
}

/** Acknowledge feed items: delivered. Covers the sibling rows of the same notification. */
export async function ackDeliveries(db: Db, actor: string, ids: number[]): Promise<{ acked: number }> {
  if (!ids.length) return { acked: 0 }
  const r = await db.query<{ id: number }>(
    `update lp.deliveries d set status = 'delivered', delivered_at = coalesce(d.delivered_at, now()), last_error = null, updated_at = now()
      where d.status <> 'delivered'
        and (d.via = $1 and d.id = any($2)
          or d.recipient = $1 and d.notification_id in (select notification_id from lp.deliveries where id = any($2) and recipient = $1))
      returning d.id`,
    [actor, ids],
  )
  return { acked: r.rows.length }
}

// ------------------------------------------------------------------ channels

export interface ChannelRow {
  id: number
  actor_id: string
  kind: ChannelKind
  label: string | null
  config: Record<string, unknown>
  has_secret: boolean
  enabled: boolean
  created_at: Date
  last_ok_at: Date | null
  last_error: string | null
  last_error_at: Date | null
}

export async function listChannels(q: Queryable, actorId?: string | null): Promise<ChannelRow[]> {
  const { rows } = await q.query<ChannelRow>(
    `select id, actor_id, kind, label, config, secret is not null as has_secret, enabled, created_at, last_ok_at, last_error, last_error_at
       from lp.delivery_channels where ($1::text is null or actor_id = $1) order by actor_id, id`,
    [actorId ?? null],
  )
  return rows
}

/** Add a channel. Returns the webhook secret / ntfy topic once (they are what the agent needs). */
export async function addChannel(
  q: Queryable,
  by: string,
  input: { actor_id: string; kind: string; label?: string | null; url?: string | null; email?: string | null; via?: string | null; target?: string | null; to?: string | null; server?: string | null },
): Promise<{ id: number; secret?: string; topic?: string }> {
  const kind = input.kind as ChannelKind
  if (!CHANNEL_KINDS.includes(kind)) throw new OpsError(`kind must be one of ${CHANNEL_KINDS.join(', ')}`)
  const a = await q.query<{ kind: string }>('select kind from lp.actors where id = $1', [input.actor_id])
  if (!a.rows[0]) throw new OpsError(`unknown actor '${input.actor_id}'`, 404)
  let config: Record<string, unknown> = {}
  let secret: string | null = null
  let topic: string | undefined
  if (kind === 'webhook') {
    const url = (input.url ?? '').trim()
    if (!/^https:\/\/[^\s]+$/.test(url)) throw new OpsError('webhook URL must start with https://')
    config = { url }
    secret = newSecret()
  } else if (kind === 'email') {
    const to = (input.email ?? '').trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new OpsError('a valid email address is required')
    config = { to }
  } else if (kind === 'ntfy') {
    const server = (input.server ?? '').trim() || 'https://ntfy.sh'
    if (!/^https:\/\//.test(server)) throw new OpsError('ntfy server must start with https://')
    topic = `md-${input.actor_id.replace(/[^a-z0-9]/g, '')}-${randomBytes(18).toString('base64url')}`.slice(0, 64)
    config = { server, topic }
  } else if (kind === 'relay') {
    const via = (input.via ?? '').trim()
    const v = await q.query<{ kind: string }>('select kind from lp.actors where id = $1', [via])
    if (!v.rows[0] || v.rows[0].kind !== 'agent') throw new OpsError('relay needs the agent that carries it (e.g. hermes)')
    config = { via, target: (input.target ?? 'whatsapp').trim() || 'whatsapp', to: (input.to ?? '').trim() || null }
  }
  const { rows } = await q.query<{ id: number }>(
    `insert into lp.delivery_channels (actor_id, kind, label, config, secret, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
    [input.actor_id, kind, input.label?.trim().slice(0, 80) || null, JSON.stringify(config), secret, by],
  )
  await q.query(
    `insert into lp.events (actor, kind, summary, entity_type, entity_id) values ($1, 'channel.added', $2, 'actor', $3)`,
    [by, `${input.actor_id} now hears through ${kind}${kind === 'relay' ? ` (via ${config.via})` : ''}`, input.actor_id],
  )
  return { id: rows[0].id, ...(secret ? { secret } : {}), ...(topic ? { topic } : {}) }
}

export async function setChannelEnabled(q: Queryable, by: string, id: number, enabled: boolean): Promise<void> {
  const { rows } = await q.query<{ actor_id: string; kind: string }>(
    'update lp.delivery_channels set enabled = $2, updated_at = now() where id = $1 returning actor_id, kind',
    [id, enabled],
  )
  if (!rows[0]) throw new OpsError('channel not found', 404)
  await q.query(
    `insert into lp.events (actor, kind, summary, entity_type, entity_id) values ($1, 'channel.updated', $2, 'actor', $3)`,
    [by, `${rows[0].actor_id}'s ${rows[0].kind} channel ${enabled ? 'turned on' : 'turned off'}`, rows[0].actor_id],
  )
}

export async function deleteChannel(q: Queryable, by: string, id: number): Promise<void> {
  const { rows } = await q.query<{ actor_id: string; kind: string }>('delete from lp.delivery_channels where id = $1 returning actor_id, kind', [id])
  if (!rows[0]) return
  await q.query(
    `insert into lp.events (actor, kind, summary, entity_type, entity_id) values ($1, 'channel.removed', $2, 'actor', $3)`,
    [by, `Removed ${rows[0].actor_id}'s ${rows[0].kind} channel`, rows[0].actor_id],
  )
}

// ------------------------------------------------------------------ status for the UI

export type DeliveryStatus = 'read' | 'delivered' | 'sent' | 'held' | 'pending' | 'failed' | 'no_channel'

export interface DeliveryState {
  notification_id: number
  recipient: string
  recipient_name: string
  recipient_kind: string
  summary: string
  created_at: Date
  status: DeliveryStatus
  last_error: string | null
  held_until: Date | null
}

/** Delivery state of every notification about a task (newest first). */
export async function taskDeliveryStates(q: Queryable, taskId: number): Promise<DeliveryState[]> {
  const { rows } = await q.query<DeliveryState>(
    `select n.id as notification_id, n.recipient, a.display_name as recipient_name, a.kind as recipient_kind, n.summary, n.created_at,
            s.status, s.last_error, s.held_until
       from lp.notifications n join lp.actors a on a.id = n.recipient
       join lp.notification_delivery s on s.notification_id = n.id
      where n.task_id = $1 order by n.id desc limit 50`,
    [taskId],
  )
  return rows
}

export async function deliveryStatesFor(q: Queryable, ids: number[]): Promise<Map<number, DeliveryState>> {
  if (!ids.length) return new Map()
  const { rows } = await q.query<DeliveryState>(
    `select n.id as notification_id, n.recipient, a.display_name as recipient_name, a.kind as recipient_kind, n.summary, n.created_at,
            s.status, s.last_error, s.held_until
       from lp.notifications n join lp.actors a on a.id = n.recipient
       join lp.notification_delivery s on s.notification_id = n.id where n.id = any($1)`,
    [ids],
  )
  return new Map(rows.map((r) => [r.notification_id, r]))
}
