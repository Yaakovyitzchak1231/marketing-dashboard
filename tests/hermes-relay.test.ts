import { describe, it, expect } from 'vitest'
// ops/hermes-relay runs on the OVH box (plain Node, no build step); its logic is tested here.
import { buildRunInput, makeRelay, parseNtfyLine, readEnvFile, sessionIdFor } from '../ops/hermes-relay/lib.mjs'

type Req = { url: string; method: string; headers: Headers; body: Record<string, unknown> | null }

function fakeWorld(opts: { runsStatus?: number; runState?: string } = {}) {
  const reqs: Req[] = []
  const execs: { bin: string; args: string[] }[] = []
  const fetch = async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null
    reqs.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body })
    if (url.endsWith('/api/ops')) {
      const op = body.op
      if (op === 'get_task') return Response.json({ ok: true, data: { id: body.task_id, comments: [{ author: 'owner', body: 'All 50 states please' }] } })
      if (op === 'claim_task') return Response.json({ ok: true, data: { id: body.task_id, status: 'claimed' } })
      return Response.json({ ok: true, data: {} })
    }
    if (url.endsWith('/v1/runs')) return Response.json({ run_id: 'run_1', status: 'started' }, { status: opts.runsStatus ?? 202 })
    if (url.includes('/v1/runs/run_1')) return Response.json({ status: opts.runState ?? 'completed', output: 'Here are 100 jewelers: ...' })
    return new Response('nope', { status: 404 })
  }
  const exec = async (bin: string, args: string[]) => {
    execs.push({ bin, args })
    return ''
  }
  const cfg = { DASHBOARD_URL: 'https://dash.example', DASHBOARD_AGENT_KEY: 'mdk_hermes_x', HERMES_API_KEY: 'hk', AGENT_ID: 'hermes', HERMES_BIN: '/bin/hermes' }
  const state = { runs: {} as Record<string, unknown> }
  const relay = makeRelay({ fetch, exec, cfg, state })
  const opsCalls = () => reqs.filter((r) => r.url.endsWith('/api/ops')).map((r) => r.body!.op)
  return { relay, reqs, execs, state, opsCalls }
}

const assigned = {
  delivery_id: 41,
  notification_id: 9,
  kind: 'assigned',
  recipient: 'hermes',
  from: 'owner',
  from_name: 'Yaakov',
  summary: 'Yaakov assigned you "Find 100 jewelers"',
  body: null,
  task: { id: 1, title: 'Find 100 jewelers', kind: 'find_leads', status: 'queued', url: 'https://dash.example/team/1' },
  relay: null,
}

describe('Hermes relay (ops/hermes-relay)', () => {
  it('an assigned task: claim, start ONE idempotent Hermes run, ack; the result completes the task', async () => {
    const w = fakeWorld()
    expect(await w.relay.handle(assigned)).toBe('acked')
    const run = w.reqs.find((r) => r.url === 'http://127.0.0.1:8643/v1/runs')!
    expect(run.headers.get('idempotency-key')).toBe('dash-evt-41')
    expect(run.headers.get('authorization')).toBe('Bearer hk')
    expect(run.body).toMatchObject({ session_id: 'dash-task-1', input: expect.stringContaining('All 50 states please') })
    expect(w.opsCalls()).toEqual(['claim_task', 'get_task', 'feed_ack', 'presence'])
    await w.relay.checkRuns()
    const done = w.reqs.filter((r) => r.body?.op === 'complete_task')
    expect(done[0].body).toMatchObject({ task_id: 1, report: 'Here are 100 jewelers: ...' })
    expect(Object.keys(w.state.runs)).toEqual([])
  })

  it('Hermes busy (429): the event is NOT acked, so the dashboard offers it again', async () => {
    const w = fakeWorld({ runsStatus: 429 })
    expect(await w.relay.handle(assigned)).toBe('retry')
    expect(w.opsCalls()).not.toContain('feed_ack')
  })

  it("a WhatsApp relay item goes through Hermes' own sender, then is acked", async () => {
    const w = fakeWorld()
    const r = await w.relay.handle({ ...assigned, delivery_id: 77, recipient: 'owner', task: null, relay: { target: 'whatsapp', to: null, text: 'Hermes: found 40 jewelers' } })
    expect(r).toBe('acked')
    expect(w.execs).toEqual([{ bin: '/bin/hermes', args: ['send', '-t', 'whatsapp', 'Hermes: found 40 jewelers'] }])
    expect(w.reqs.find((x) => x.body?.op === 'feed_ack')!.body).toMatchObject({ ids: [77] })
  })

  it('a direct message gets a reply message back to the sender', async () => {
    const w = fakeWorld()
    await w.relay.handle({ ...assigned, kind: 'message', task: null, body: 'How many did you find?' })
    const run = w.reqs.find((r) => r.url.endsWith('/v1/runs'))!
    expect(run.body).toMatchObject({ session_id: 'dash-dm-owner' })
    await w.relay.checkRuns()
    expect(w.reqs.find((r) => r.body?.op === 'send_message')!.body).toMatchObject({ to: 'owner', body: 'Here are 100 jewelers: ...' })
  })

  it('helpers', () => {
    expect(parseNtfyLine('{"id":"abc","event":"message","message":"{\\"d\\":4}"}')).toEqual({ id: 'abc', isMessage: true })
    expect(parseNtfyLine('{"id":"k","event":"keepalive"}')).toEqual({ id: 'k', isMessage: false })
    expect(parseNtfyLine('garbage')).toBeNull()
    expect(readEnvFile('# c\nAPI_SERVER_KEY="abc"\nexport X=1\n')).toEqual({ API_SERVER_KEY: 'abc', X: '1' })
    expect(sessionIdFor(assigned)).toBe('dash-task-1')
    expect(buildRunInput(assigned, null)).toContain("needs Yaakov's OK first")
  })
})
