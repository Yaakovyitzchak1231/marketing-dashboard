import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestDb } from './helpers/pglite-db'
import { createTask, handoffTask, sendMessage, comment, markRead, OpsError } from '@/lib/ops/core'
import { runOp, routeToOp } from '@/lib/ops/dispatch'
import { ackDeliveries, addChannel, dispatchDue, feed, signWebhook, taskDeliveryStates, MAX_ATTEMPTS } from '@/lib/notify/deliver'
import { addActor, agentForDbKey, mintAgentKey, revokeAgentKey } from '@/lib/notify/keys'
import { sendMail } from '@/lib/notify/mail'
import { shabbosEndsAt, sunsetUtc } from '@/lib/notify/shabbos'
import { handleMcp, MCP_TOOLS } from '@/lib/notify/mcp'
import { saveDraft, sendPageComments } from '@/lib/page-comments/core'
import { makeRelay } from '../ops/hermes-relay/lib.mjs'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})

interface Call {
  url: string
  init: RequestInit
}
function fakeFetch(answer: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const f = async (url: string, init: RequestInit = {}) => {
    const c = { url: String(url), init }
    calls.push(c)
    return answer(c)
  }
  return { f, calls }
}
// Dispatch runs with an injected clock. Rows are due from the real now(), so the test clock is
// always ahead of it: the next Tuesday noon (no quiet hours) and the next Saturday noon (Shabbos).
function nextUtcDay(weekday: number, hourUtc: number): Date {
  const d = new Date(Date.now() + 24 * 3600_000)
  d.setUTCHours(hourUtc, 0, 0, 0)
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1)
  return d
}
const WEEKDAY = nextUtcDay(2, 16)
const SATURDAY_NOON = nextUtcDay(6, 16)
const MAIL_ENV = { MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'test-key', MAIL_FROM: 'Dashboard <alerts@example.com>', DASHBOARD_URL: 'https://dash.example' } as unknown as NodeJS.ProcessEnv

async function deliveriesOf(notificationId: number) {
  const { rows } = await db.query<{ id: number; status: string; attempts: number; last_error: string | null; kind: string }>(
    'select d.id, d.status, d.attempts, d.last_error, c.kind from lp.deliveries d join lp.delivery_channels c on c.id = d.channel_id where d.notification_id = $1 order by d.id',
    [notificationId],
  )
  return rows
}
async function lastNotification(recipient: string) {
  const { rows } = await db.query<{ id: number; kind: string; body: string | null }>('select id, kind, body from lp.notifications where recipient = $1 order by id desc limit 1', [recipient])
  return rows[0]
}

describe('migration 0013', () => {
  it("keeps Tab's mailbox and adds legacy feed access",  async () => {
    const { rows } = await db.query<{ kind: string; config: { to: string } }>("select kind, config from lp.delivery_channels where actor_id = 'tab'")
    expect(rows).toEqual([{ kind: 'email', config: { to: 'yaakov-tab@mail.tab.bot' } }, { kind: 'pull', config: {} }])
  })

  it('every notification fans out to each enabled channel of its recipient, in the same transaction', async () => {
    await createTask(db, 'owner', { title: 'Find 100 jewelers', kind: 'find_leads', assigned_to: 'tab' })
    const n = await lastNotification('tab')
    const d = await deliveriesOf(n.id)
    expect(d.map((x) => [x.kind, x.status])).toEqual([['email', 'pending'], ['pull', 'pending']])
  })
})

describe('webhook channel', () => {
  it('POSTs the event signed with HMAC-SHA256 over "timestamp.body", and marks it delivered on 2xx', async () => {
    await addActor(db, 'owner', { id: 'claude-code', display_name: 'Claude Code', harness: 'claude-code' })
    const ch = await addChannel(db, 'owner', { actor_id: 'claude-code', kind: 'webhook', url: 'https://agent.example/hook' })
    expect(ch.secret).toMatch(/^whsec_/)
    const t = await createTask(db, 'owner', { title: 'Write the follow-up', assigned_to: 'claude-code', body: 'Use the jeweler tone' })
    const { f, calls } = fakeFetch(() => new Response('ok', { status: 200 }))
    const r = await dispatchDue(db, { fetchImpl: f, now: WEEKDAY, env: MAIL_ENV })
    const hook = calls.find((c) => c.url === 'https://agent.example/hook')!
    expect(hook).toBeTruthy()
    const h = new Headers(hook.init.headers)
    const body = String(hook.init.body)
    const expected = createHmac('sha256', ch.secret!).update(`${h.get('x-dashboard-timestamp')}.${body}`).digest('hex')
    expect(h.get('x-dashboard-signature')).toBe(`sha256=${expected}`)
    expect(signWebhook(ch.secret!, h.get('x-dashboard-timestamp')!, body)).toBe(expected)
    const ev = JSON.parse(body)
    expect(ev).toMatchObject({ type: 'notification', kind: 'assigned', recipient: 'claude-code', from: 'owner', from_name: 'Yaakov', task: { id: t.id, title: 'Write the follow-up', url: `https://dash.example/team/${t.id}` } })
    expect(r.delivered).toBeGreaterThanOrEqual(1)
    const states = await taskDeliveryStates(db, t.id)
    expect(states[0]).toMatchObject({ recipient: 'claude-code', status: 'delivered' })
  })

  it('retries a 500 with backoff, and gives up at once on a 4xx with the reason visible', async () => {
    await addActor(db, 'owner', { id: 'flaky', display_name: 'Flaky' })
    await addChannel(db, 'owner', { actor_id: 'flaky', kind: 'webhook', url: 'https://flaky.example/hook' })
    await createTask(db, 'owner', { title: 'Retry me', assigned_to: 'flaky' })
    const n = await lastNotification('flaky')
    let status = 500
    const { f } = fakeFetch((c) => (c.url.includes('flaky') ? new Response('no', { status }) : new Response('ok')))
    await dispatchDue(db, { fetchImpl: f, now: WEEKDAY, env: MAIL_ENV })
    let d = (await deliveriesOf(n.id)).find((x) => x.kind === 'webhook')!
    expect(d).toMatchObject({ status: 'pending', attempts: 1, last_error: 'answered 500' })
    // Not due again until the backoff passes.
    const again = await dispatchDue(db, { fetchImpl: f, now: WEEKDAY, env: MAIL_ENV })
    expect(again.picked).toBe(0)
    status = 404
    await dispatchDue(db, { fetchImpl: f, now: new Date(WEEKDAY.getTime() + 60_000), env: MAIL_ENV })
    d = (await deliveriesOf(n.id)).find((x) => x.kind === 'webhook')!
    expect(d).toMatchObject({ status: 'failed', last_error: 'answered 404' })
    const ev = await db.query<{ summary: string }>("select summary from lp.events where kind = 'delivery.failed' order by id desc limit 1")
    expect(ev.rows[0].summary).toContain('Flaky (webhook)')
    expect(MAX_ATTEMPTS).toBeGreaterThan(3)
  })
})

describe('new agents', () => {
  it('get a default pull channel, so their feed works before any push channel is added', async () => {
    await addActor(db, 'owner', { id: 'fresh-agent', display_name: 'Fresh' })
    const ch = await db.query<{ kind: string }>("select kind from lp.delivery_channels where actor_id = 'fresh-agent'")
    expect(ch.rows.map((r) => r.kind)).toEqual(['pull'])
    await createTask(db, 'owner', { title: 'Hello fresh', assigned_to: 'fresh-agent' })
    const items = await feed(db, 'fresh-agent', { limit: 10 })
    expect(items.some((e) => e.summary.includes('Hello fresh'))).toBe(true)
    // A person is a team change: made as the owner, in a transaction (0050/0051), as app/actions/connect.ts does.
    await db.tx((q) => addActor(q, 'owner', { id: 'a-person', display_name: 'Person', kind: 'human' }), 'owner')
    const none = await db.query("select 1 from lp.delivery_channels where actor_id = 'a-person'")
    expect(none.rows).toHaveLength(0)
  })

  it('webhook delivery does not follow redirects', async () => {
    await addActor(db, 'owner', { id: 'redir', display_name: 'Redir' })
    await addChannel(db, 'owner', { actor_id: 'redir', kind: 'webhook', url: 'https://redir.example/hook' })
    await createTask(db, 'owner', { title: 'No redirects', assigned_to: 'redir' })
    const { f, calls } = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }))
    await dispatchDue(db, { fetchImpl: f, now: WEEKDAY, env: MAIL_ENV, limit: 500 })
    const hook = calls.find((c) => c.url === 'https://redir.example/hook')!
    expect(hook.init.redirect).toBe('manual')
    expect(calls.some((c) => c.url.includes('169.254'))).toBe(false)
  })
})

describe('email channel (Tab)', () => {
  it('says plainly when mail is not configured, as a retryable (not permanent) state', async () => {
    const r = await sendMail({ to: 'a@b.co', subject: 's', text: 't' }, async () => new Response('x'), {} as NodeJS.ProcessEnv)
    expect(r).toMatchObject({ ok: false, retry: true, unconfigured: true })
    expect((r as { error: string }).error).toMatch(/waiting for mail settings/)
  })

  it('holds emails while MAIL_* are missing (no attempts burned), then sends them once the settings exist', async () => {
    const t = await createTask(db, 'owner', { title: 'Find 100 jewelers (held mail)', assigned_to: 'tab' })
    const n = await db.query<{ id: number }>("select id from lp.notifications where task_id = $1 and recipient = 'tab' order by id limit 1", [t.id])
    const nid = n.rows[0].id
    const noMail = { DASHBOARD_URL: 'https://dash.example' } as unknown as NodeJS.ProcessEnv
    const { f, calls } = fakeFetch(() => Response.json({ id: 'msg_held' }))
    // Many dispatches over hours (the live page dispatches every 10 s): it stays held, never failed.
    for (let i = 0; i < MAX_ATTEMPTS + 4; i++) {
      await dispatchDue(db, { fetchImpl: f, now: new Date(WEEKDAY.getTime() + i * 10 * 60_000), env: noMail, limit: 500 })
    }
    let d = (await deliveriesOf(nid)).find((x) => x.kind === 'email')!
    expect(d).toMatchObject({ status: 'held', attempts: 0 })
    expect(d.last_error).toMatch(/waiting for mail settings/)
    expect(calls.filter((c) => c.url.includes('resend') || c.url.includes('brevo'))).toHaveLength(0)
    const st = (await taskDeliveryStates(db, t.id)).find((s) => s.notification_id === nid)!
    expect(st.status).toBe('held')
    expect(st.last_error).toMatch(/waiting for mail settings/)
    // 0014 puts deliveries that the old code failed for good ("mail is not configured") back on hold.
    await db.query(
      "update lp.deliveries set status = 'failed', failed_at = now(), attempts = 1, last_error = 'mail is not configured (MAIL_PROVIDER, MAIL_API_KEY, MAIL_FROM)' where id = $1",
      [d.id],
    )
    const sql = readFileSync(join(__dirname, '..', 'db', 'migrations', '0014_mail_hold.sql'), 'utf8')
    for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.replace(/--.*$/gm, '').trim())) await db.query(stmt)
    d = (await deliveriesOf(nid)).find((x) => x.kind === 'email')!
    expect(d).toMatchObject({ status: 'held', attempts: 0 })
    expect(d.last_error).toMatch(/waiting for mail settings/)
    // Yaakov adds the three settings: the next dispatch after the recheck sends it.
    const later = new Date(WEEKDAY.getTime() + (MAX_ATTEMPTS + 6) * 10 * 60_000)
    await dispatchDue(db, { fetchImpl: f, now: later, env: MAIL_ENV, limit: 500 })
    d = (await deliveriesOf(nid)).find((x) => x.kind === 'email')!
    expect(d).toMatchObject({ status: 'sent', attempts: 1, last_error: null })
    expect(calls.some((c) => c.url === 'https://api.resend.com/emails' && String(c.init.body).includes('Find 100 jewelers (held mail)'))).toBe(true)
  })

  it("mails Tab's mailbox through the provider's HTTPS API with the task and how to act on it", async () => {
    const t = await createTask(db, 'owner', { title: 'Research Gem Co', assigned_to: 'tab' })
    const { f, calls } = fakeFetch(() => Response.json({ id: 'msg_1' }))
    await dispatchDue(db, { fetchImpl: f, now: WEEKDAY, env: MAIL_ENV })
    const mail = calls.filter((c) => c.url === 'https://api.resend.com/emails').map((c) => JSON.parse(String(c.init.body)))
    const m = mail.find((x) => String(x.subject).includes('Research Gem Co'))
    expect(m).toMatchObject({ from: 'Dashboard <alerts@example.com>', to: ['yaakov-tab@mail.tab.bot'] })
    expect(m.text).toContain(`"op":"claim_task","task_id":${t.id}`)
    const states = await taskDeliveryStates(db, t.id)
    expect(states[0].status).toBe('sent')
  })
})

describe('ntfy wake-up + feed + ack (Hermes-style relay, no public port)', () => {
  it('pings with only an id, the agent reads the event from its feed, ack marks it delivered', async () => {
    const ch = await addChannel(db, 'owner', { actor_id: 'hermes', kind: 'ntfy' })
    expect(ch.topic).toMatch(/^md-hermes-[A-Za-z0-9_-]{16,}$/)
    const t = await createTask(db, 'owner', { title: 'SEO fix: alt text', assigned_to: 'hermes' })
    const { f, calls } = fakeFetch(() => new Response('ok'))
    await dispatchDue(db, { fetchImpl: f, now: WEEKDAY, env: MAIL_ENV })
    const ping = calls.find((c) => c.url === `https://ntfy.sh/${ch.topic}`)!
    expect(Object.keys(JSON.parse(String(ping.init.body)))).toEqual(['d'])
    expect(String(ping.init.body)).not.toContain('SEO')
    const items = await feed(db, 'hermes')
    const mine = items.find((e) => e.task?.id === t.id)!
    expect(mine).toMatchObject({ kind: 'assigned', summary: expect.stringContaining('SEO fix') })
    // Not handed out twice within 2 minutes.
    expect((await feed(db, 'hermes')).find((e) => e.task?.id === t.id)).toBeUndefined()
    expect(await ackDeliveries(db, 'hermes', [mine.delivery_id])).toEqual({ acked: 2 })
    expect((await taskDeliveryStates(db, t.id))[0].status).toBe('delivered')
    // Another agent cannot ack it.
    expect(await ackDeliveries(db, 'tab', [mine.delivery_id])).toEqual({ acked: 0 })
  })

  it('the REST aliases exist: GET /api/ops/feed, POST /api/ops/feed/ack, POST /api/ops/messages', () => {
    expect(routeToOp('GET', ['feed'])).toEqual({ op: 'feed', args: {} })
    expect(routeToOp('POST', ['feed', 'ack'])).toEqual({ op: 'feed_ack', args: {} })
    expect(routeToOp('POST', ['messages'])).toEqual({ op: 'send_message', args: {} })
  })
})

describe('agent -> human: relay to WhatsApp via Hermes, held over Shabbos', () => {
  it('holds a ping to Yaakov during Shabbos, then hands it to Hermes after nightfall', async () => {
    await addChannel(db, 'owner', { actor_id: 'owner', kind: 'relay', via: 'hermes', target: 'whatsapp' })
    await sendMessage(db, 'hermes', { to: 'owner', body: 'Found 40 jewelers in Ohio, list is on the task.' })
    const n = await lastNotification('owner')
    expect(n).toMatchObject({ kind: 'message', body: 'Found 40 jewelers in Ohio, list is on the task.' })
    const friNight = SATURDAY_NOON // Shabbos in Baltimore whatever the season
    const { f, calls } = fakeFetch(() => new Response('ok'))
    await dispatchDue(db, { fetchImpl: f, now: friNight, env: MAIL_ENV })
    let d = (await deliveriesOf(n.id))[0]
    expect(d.status).toBe('held')
    const st = await db.query<{ status: string; held_until: Date }>('select status, held_until from lp.notification_delivery where notification_id = $1', [n.id])
    expect(st.rows[0].status).toBe('held')
    expect(new Date(st.rows[0].held_until).toISOString()).toBe(shabbosEndsAt(friNight)!.toISOString())
    // Hermes' feed does not offer it while held.
    expect((await feed(db, 'hermes', { now: friNight })).some((e) => e.notification_id === n.id)).toBe(false)
    const after = new Date(shabbosEndsAt(friNight)!.getTime() + 1000)
    await dispatchDue(db, { fetchImpl: f, now: after, env: MAIL_ENV })
    d = (await deliveriesOf(n.id))[0]
    expect(d.status).toBe('sent')
    expect(calls.some((c) => c.url.startsWith('https://ntfy.sh/md-hermes-'))).toBe(true)
    const relayItem = (await feed(db, 'hermes', { now: after })).find((e) => e.notification_id === n.id)!
    expect(relayItem.relay).toMatchObject({ target: 'whatsapp', text: expect.stringContaining('Found 40 jewelers') })
    await ackDeliveries(db, 'hermes', [relayItem.delivery_id])
    expect((await deliveriesOf(n.id))[0].status).toBe('delivered')
    await markRead(db, 'owner')
    const read = await db.query<{ status: string }>('select status from lp.notification_delivery where notification_id = $1', [n.id])
    expect(read.rows[0].status).toBe('read')
  })
})

describe('agent -> agent', () => {
  it('carries full mention bodies and marks informational replies to prevent loops', async () => {
    const task = await createTask(db, 'owner', { title: 'Full context' })
    const body = `@hermes ${'context '.repeat(100)}final instruction`
    const mention = await comment(db, 'tab', { task_id: task.id, body })
    const events = await feed(db, 'hermes')
    expect(events.find((e) => e.comment_id === mention.id)?.body).toBe(body)
    const sent = await runOp(db, 'hermes', 'send_message', { to: 'tab', body: 'Result, not a new request', no_reply: true }) as { notification_id: number }
    const replies = await feed(db, 'tab')
    expect(replies.find((e) => e.notification_id === sent.notification_id)?.auto_reply).toBe(true)
  })

  it('a direct message, a handoff and an @mention all reach the other agent', async () => {
    const r = (await runOp(db, 'hermes', 'send_message', { to: 'claude-code', body: 'Can you draft the Ohio email?' })) as { notification_id: number }
    expect(r.notification_id).toBeTruthy()
    const t = await createTask(db, 'owner', { title: 'Ohio list' })
    await db.query("update lp.tasks set claimed_by = 'hermes', status = 'claimed', attempts = 1, lease_expires_at = now() + interval '5 minutes' where id = $1", [t.id])
    await handoffTask(db, 'hermes', t.id, { to: 'claude-code', note: 'yours' })
    await comment(db, 'hermes', { task_id: t.id, body: '@claude-code check row 4' })
    const { rows } = await db.query<{ kind: string; status: string }>(
      `select n.kind, s.status from lp.notifications n join lp.notification_delivery s on s.notification_id = n.id
        where n.recipient = 'claude-code' and n.created_by = 'hermes' order by n.id`,
    )
    expect(rows.map((x) => x.kind)).toEqual(['message', 'handoff', 'mention'])
    expect(rows.every((x) => x.status === 'pending')).toBe(true)
  })

  it('an agent with no enabled channel shows "not connected" instead of silently waiting', async () => {
    await addActor(db, 'owner', { id: 'disconnected', display_name: 'Disconnected' })
    await db.query("update lp.delivery_channels set enabled = false where actor_id = 'disconnected'")
    await createTask(db, 'owner', { title: 'No channel', assigned_to: 'disconnected' })
    const n = await lastNotification('disconnected')
    const s = await db.query<{ status: string }>('select status from lp.notification_delivery where notification_id = $1', [n.id])
    expect(s.rows[0].status).toBe('no_channel')
  })
})

describe('agent keys in the database', () => {
  it('mint -> works as a bearer key (hashed at rest) -> revoke -> refused', async () => {
    const { key, row } = await mintAgentKey(db, 'owner', 'hermes', 'OVH relay')
    expect(key).toMatch(/^mdk_hermes_/)
    const stored = await db.query<{ key_hash: string }>('select key_hash from lp.agent_keys where id = $1', [row.id])
    expect(stored.rows[0].key_hash).not.toContain(key)
    expect(await agentForDbKey(db, `Bearer ${key}`)).toBe('hermes')
    expect(await agentForDbKey(db, 'Bearer nope')).toBeNull()
    await revokeAgentKey(db, 'owner', row.id)
    expect(await agentForDbKey(db, `Bearer ${key}`)).toBeNull()
  })

  it('people get no keys', async () => {
    await expect(mintAgentKey(db, 'owner', 'owner')).rejects.toThrow(/keys are for agents/)
  })
})

describe('MCP server', () => {
  it('initialize, tools/list, tools/call', async () => {
    const init = await handleMcp(db, 'claude-code', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    expect(init).toMatchObject({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'marketing-dashboard' } } })
    expect(await handleMcp(db, 'claude-code', { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    const list = (await handleMcp(db, 'claude-code', { jsonrpc: '2.0', id: 2, method: 'tools/list' })) as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['get_events', 'ack_events', 'list_my_tasks', 'claim_task', 'post_update', 'complete_task', 'send_message']))
    const call = (await handleMcp(db, 'claude-code', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_message', arguments: { to: 'owner', body: 'Draft is on the task' } } })) as {
      result: { isError?: boolean; content: { text: string }[] }
    }
    expect(call.result.isError).toBeUndefined()
    expect((await lastNotification('owner')).body).toBe('Draft is on the task')
    const bad = (await handleMcp(db, 'claude-code', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'send_message', arguments: { to: 'nobody', body: 'x' } } })) as {
      result: { isError: boolean }
    }
    expect(bad.result.isError).toBe(true)
    expect(MCP_TOOLS.length).toBeGreaterThanOrEqual(10)
  })
})

describe('Hermes relay against the actual ops/database contract', () => {
  function connectedRelay(actor = 'hermes', output = 'Verified report: @tab stays quiet; cc @owner') {
    let starts = 0
    const relay = makeRelay({
      cfg: { DASHBOARD_URL: 'https://dash.test', AGENT_ID: actor, RUN_FROM: 'owner,tab,hermes' },
      exec: async () => { throw new Error('Unexpected external send') },
      fetch: async (url: string, init: RequestInit = {}) => {
        if (url === 'https://dash.test/api/ops') {
          const args = JSON.parse(String(init.body))
          try {
            return Response.json({ ok: true, data: await runOp(db, actor, args.op, args) })
          } catch (e) {
            return Response.json({ ok: false, error: (e as Error).message }, { status: e instanceof OpsError ? e.status : 500 })
          }
        }
        if (url === 'http://127.0.0.1:8643/v1/runs') {
          starts++
          return Response.json({ run_id: `fixture_${starts}` }, { status: 202 })
        }
        if (url.startsWith('http://127.0.0.1:8643/v1/runs/')) return Response.json({ status: 'completed', output })
        throw new Error('Unexpected URL')
      },
    })
    return { relay, starts: () => starts }
  }

  it('claims, acknowledges and completes using the stored attempt; report mentions do not wake agents', async () => {
    const t = await createTask(db, 'owner', { title: 'Integrated relay task', assigned_to: 'hermes' })
    const ev = (await feed(db, 'hermes')).find((e) => e.task?.id === t.id)!
    const w = connectedRelay()
    expect(await w.relay.handle(ev)).toBe('acked')
    await w.relay.checkRuns()
    const row = (await db.query<{ status: string; attempts: number; report: string }>('select status, attempts, report from lp.tasks where id = $1', [t.id])).rows[0]
    expect(row).toMatchObject({ status: 'done', attempts: 1, report: 'Verified report: @\u200btab stays quiet; cc @owner' })
    const mentions = await db.query<{ recipient: string }>("select recipient from lp.notifications where task_id = $1 and kind = 'mention'", [t.id])
    expect(mentions.rows.map((r) => r.recipient)).toEqual(['owner'])
    expect((await db.query<{ status: string }>('select status from lp.deliveries where id = $1', [ev.delivery_id])).rows[0].status).toBe('delivered')
  })

  it('answers a pinned page comment on its stored thread, with an informational notification', async () => {
    const pin = await saveDraft(db, 'owner', { client_id: 'relay-integrated-pin', recipient: 'hermes', page_path: '/seo', body: 'Check this label' })
    await sendPageComments(db, 'owner', ['relay-integrated-pin'], { DASHBOARD_URL: 'https://dash.test', NODE_ENV: 'test' })
    const ev = (await feed(db, 'hermes')).find((e) => e.page_comment_id === pin.id)!
    expect(ev).toBeDefined()
    const w = connectedRelay('hermes', 'The label is correct.')
    await w.relay.handle(ev)
    await w.relay.checkRuns()
    const rows = await db.query<{ author: string; body: string; auto_reply: boolean; page_comment_id: number }>(
      'select r.author, r.body, n.auto_reply, n.page_comment_id from lp.page_comment_replies r join lp.notifications n on n.id = r.notification_id where r.page_comment_id = $1', [pin.id],
    )
    expect(rows.rows).toEqual([{ author: 'hermes', body: 'The label is correct.', auto_reply: true, page_comment_id: pin.id }])
  })

  it('an agent DM receives one informational reply that another relay acknowledges without a run', async () => {
    const sent = await sendMessage(db, 'tab', { to: 'hermes', body: 'Check availability' })
    const ev = (await feed(db, 'hermes')).find((e) => e.notification_id === sent.notification_id)!
    const hermes = connectedRelay('hermes', 'Available.')
    await hermes.relay.handle(ev)
    await hermes.relay.checkRuns()
    const reply = (await feed(db, 'tab')).find((e) => e.from === 'hermes' && e.body === 'Available.')!
    expect(reply.auto_reply).toBe(true)
    const tab = connectedRelay('tab')
    expect(await tab.relay.handle(reply)).toBe('acked')
    expect(tab.starts()).toBe(0)
  })
})

describe('Shabbos quiet hours (Baltimore)', () => {
  it('computes sunset within a few minutes of the published time', () => {
    // Published: Oct 9 2026 ~6:38 PM EDT (22:38 UTC); Jun 20 2026 ~8:37 PM EDT.
    expect(Math.abs(sunsetUtc(2026, 10, 9).getTime() - Date.parse('2026-10-09T22:38:00Z'))).toBeLessThan(5 * 60_000)
    expect(Math.abs(sunsetUtc(2026, 6, 20).getTime() - Date.parse('2026-06-21T00:37:00Z'))).toBeLessThan(5 * 60_000)
  })
  it('Friday afternoon no; Friday night and Saturday yes; Saturday late night no', () => {
    expect(shabbosEndsAt(new Date('2026-10-09T19:00:00Z'))).toBeNull()
    expect(shabbosEndsAt(new Date('2026-10-09T23:00:00Z'))).not.toBeNull()
    expect(shabbosEndsAt(new Date('2026-10-10T16:00:00Z'))).not.toBeNull()
    expect(shabbosEndsAt(new Date('2026-10-11T01:00:00Z'))).toBeNull()
    expect(shabbosEndsAt(WEEKDAY)).toBeNull()
    expect(shabbosEndsAt(SATURDAY_NOON)).not.toBeNull()
  })
})
