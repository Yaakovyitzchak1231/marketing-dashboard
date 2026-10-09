import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createTestDb } from './helpers/pglite-db'

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db, dbConfigured: () => Boolean(holder.db) }))
vi.mock('@/lib/reports/load', () => ({ loadWeeklyReport: async () => ({ sample: true, report: { ok: 1 } }) }))

import { GET as opsGet, POST as opsPost } from '@/app/api/ops/[[...path]]/route'
import { GET as importGet, POST as importPost } from '@/app/api/ops/import/lead-master/route'
import { GET as exportGet } from '@/app/api/ops/export/lead-master/route'
import { GET as weeklyGet } from '@/app/api/ops/reports/weekly/route'
import { pauseAgent, pauseAll, pauseBlockFor, resumeAgent, resumeAll } from '@/lib/ops/pause'
import { createTask, claimTask, OpsError } from '@/lib/ops/core'
import { listActors } from '@/lib/ops/queries'

const TAB = 'tab-token-0123456789abcdefghijkl'
const HERMES = 'hermes-token-0123456789abcdefghij'
const CRON = 'cron-secret-0123456789abcdef'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb

beforeEach(async () => {
  db = await createTestDb()
  holder.db = db
  vi.stubEnv('OPS_AGENT_TOKENS', `tab:${TAB},hermes:${HERMES}`)
  vi.stubEnv('CRON_SECRET', CRON)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  holder.db = null
  await db.close()
})

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const ctx = (path?: string[]) => ({ params: Promise.resolve({ path }) })
// The catch-all route reads req.nextUrl; a plain Request plus nextUrl is enough here.
function nreq(url: string, init: RequestInit = {}) {
  const r = new Request(url, init) as Request & { nextUrl: URL }
  r.nextUrl = new URL(url)
  return r as never
}

/** One request to every /api/ops route, as the given token. */
async function hitEveryRoute(token: string): Promise<Record<string, number>> {
  const h = auth(token)
  return {
    list: (await opsGet(nreq('https://x/api/ops', { headers: h }), ctx())).status,
    op: (await opsPost(nreq('https://x/api/ops', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'inbox' }) }), ctx())).status,
    claim: (await opsPost(nreq('https://x/api/ops/tasks/claim', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' }), ctx(['tasks', 'claim']))).status,
    importGet: (await importGet(new Request('https://x/api/ops/import/lead-master', { headers: h }))).status,
    importPost: (await importPost(new Request('https://x/api/ops/import/lead-master?dry_run=1', { method: 'POST', headers: { ...h, 'Content-Type': 'text/csv' }, body: 'email\nowner@gem.example\n' }))).status,
    exportGet: (await exportGet(new Request('https://x/api/ops/export/lead-master', { headers: h }))).status,
    weekly: (await weeklyGet(new Request('https://x/api/ops/reports/weekly', { headers: h }))).status,
  }
}

describe('pause one agent', () => {
  it('a paused agent gets 423 "agent paused by Yaakov" on every /api/ops route; other agents keep working', async () => {
    const before = await hitEveryRoute(TAB)
    expect(Object.values(before).every((s) => s !== 423 && s !== 401)).toBe(true)

    await pauseAgent(db, 'owner', 'tab', 'checking the Segment 3 upload')
    const after = await hitEveryRoute(TAB)
    expect(after).toEqual({ list: 423, op: 423, claim: 423, importGet: 423, importPost: 423, exportGet: 423, weekly: 423 })

    const r = await opsGet(nreq('https://x/api/ops', { headers: auth(TAB) }), ctx())
    const j = await r.json()
    expect(j.ok).toBe(false)
    expect(j.error).toMatch(/agent paused by Yaakov/)
    expect(j.error).toMatch(/checking the Segment 3 upload/)
    expect(j.paused).toMatchObject({ scope: 'agent', by: 'owner', by_name: 'Yaakov', reason: 'checking the Segment 3 upload' })

    const hermes = await hitEveryRoute(HERMES)
    expect(Object.values(hermes).includes(423)).toBe(false)

    await resumeAgent(db, 'owner', 'tab')
    expect(Object.values(await hitEveryRoute(TAB)).includes(423)).toBe(false)
  })

  it('a refused request changes nothing: the paused agent cannot claim, and its open claims stay as they were', async () => {
    const mine = await createTask(db, 'owner', { title: 'Research Gem Co', kind: 'research_company', assigned_to: 'tab' })
    await claimTask(db, 'tab', { task_id: mine.id })
    await createTask(db, 'owner', { title: 'Another', kind: 'research_company' })
    await pauseAgent(db, 'owner', 'tab')

    const r = await opsPost(nreq('https://x/api/ops/tasks/claim', { method: 'POST', headers: { ...auth(TAB), 'Content-Type': 'application/json' }, body: '{}' }), ctx(['tasks', 'claim']))
    expect(r.status).toBe(423)
    const t = await db.query<{ title: string; claimed_by: string | null; status: string }>('select title, claimed_by, status from lp.tasks order by id')
    expect(t.rows).toEqual([
      { title: 'Research Gem Co', claimed_by: 'tab', status: 'claimed' },
      { title: 'Another', claimed_by: null, status: 'queued' },
    ])
    // Still shown on the Agents page with its open task and the pause.
    const tab = (await listActors(db)).find((a) => a.id === 'tab')!
    expect(tab.active_tasks).toBe(1)
    expect(tab.paused_by_name).toBe('Yaakov')
    expect(tab.paused_at).toBeTruthy()
  })

  it('pause and resume each write one activity-log row with the human as actor; repeats are no-ops', async () => {
    expect(await pauseAgent(db, 'owner', 'hermes', '  too many retries  ')).toEqual({ changed: true })
    expect(await pauseAgent(db, 'owner', 'hermes', 'again')).toEqual({ changed: false })
    expect(await resumeAgent(db, 'owner', 'hermes')).toEqual({ changed: true })
    expect(await resumeAgent(db, 'owner', 'hermes')).toEqual({ changed: false })
    const ev = await db.query<{ actor: string; kind: string; summary: string; entity_id: string; data: { reason?: string; reason_was?: string } }>(
      "select actor, kind, summary, entity_id, data from lp.events where kind like 'agent.%' order by id",
    )
    expect(ev.rows.map((e) => [e.actor, e.kind, e.entity_id])).toEqual([
      ['owner', 'agent.paused', 'hermes'],
      ['owner', 'agent.resumed', 'hermes'],
    ])
    expect(ev.rows[0].summary).toBe('Yaakov paused Hermes: too many retries. Its 0 open tasks stay as they are.')
    expect(ev.rows[0].data.reason).toBe('too many retries')
    expect(ev.rows[1].data.reason_was).toBe('too many retries')
  })
})

describe('humans are never pausable, and only humans pause', () => {
  it('a person cannot be paused, by the app or straight in the database', async () => {
    await expect(pauseAgent(db, 'owner', 'owner')).rejects.toThrow(/only agents can be paused/)
    await expect(db.query("update lp.actors set paused_at = now(), paused_by = 'owner' where id = 'owner'")).rejects.toThrow(/actors_pause_agents_only/)
  })

  it('an agent cannot pause anyone: the app refuses and the database refuses', async () => {
    await expect(pauseAgent(db, 'tab', 'hermes')).rejects.toBeInstanceOf(OpsError)
    await expect(pauseAll(db, 'tab')).rejects.toThrow(/Only a person/)
    await expect(db.query("update lp.actors set paused_at = now(), paused_by = 'tab' where id = 'hermes'")).rejects.toThrow(/only a human can pause/)
    await expect(db.query("insert into lp.agent_pause_all (paused_by) values ('tab')")).rejects.toThrow(/only a human can pause/)
  })

  it('there is no ops call an agent could use to pause or resume', async () => {
    const r = await opsGet(nreq('https://x/api/ops', { headers: auth(TAB) }), ctx())
    const ops = Object.keys((await r.json()).ops)
    expect(ops.filter((o) => /pause|resume/i.test(o))).toEqual([])
  })
})

describe('pause all agents (kill switch)', () => {
  it('refuses every agent, including the cron caller, until lifted; single pauses survive lifting it', async () => {
    await pauseAgent(db, 'owner', 'hermes', 'own reason')
    await pauseAll(db, 'owner', 'bad data in the last batch')
    expect(await pauseAll(db, 'owner')).toEqual({ changed: false })

    const r = await importGet(new Request('https://x/api/ops/import/lead-master', { headers: auth(TAB) }))
    expect(r.status).toBe(423)
    const j = await r.json()
    expect(j.error).toMatch(/All agents are paused \(agent paused by Yaakov\)/)
    expect(j.paused).toMatchObject({ scope: 'all', reason: 'bad data in the last batch' })
    expect((await exportGet(new Request('https://x/api/ops/export/lead-master', { headers: auth(CRON) }))).status).toBe(423)
    // Hermes's own pause is the one it hears about.
    expect((await pauseBlockFor(db, 'hermes'))?.scope).toBe('agent')

    await resumeAll(db, 'owner')
    expect(Object.values(await hitEveryRoute(TAB)).includes(423)).toBe(false)
    expect((await importGet(new Request('https://x/api/ops/import/lead-master', { headers: auth(HERMES) }))).status).toBe(423)

    const ev = await db.query<{ kind: string; summary: string }>("select kind, summary from lp.events where kind like 'agent.%' order by id")
    expect(ev.rows.map((e) => e.kind)).toEqual(['agent.paused', 'agent.paused_all', 'agent.resumed_all'])
    expect(ev.rows[2].summary).toMatch(/Still paused one by one: Hermes/)
  })
})

describe('the gate', () => {
  it('fails closed when the pause state cannot be read', async () => {
    holder.db = { query: async () => { throw new Error('relation "lp.agent_pause_all" does not exist') }, tx: async () => { throw new Error('x') } }
    const r = await weeklyGet(new Request('https://x/api/ops/reports/weekly', { headers: auth(TAB) }))
    expect(r.status).toBe(503)
    expect((await r.json()).error).toMatch(/Could not check whether tab is paused/)
  })

  it('a bad token is still 401, not 423', async () => {
    await pauseAll(db, 'owner')
    expect((await weeklyGet(new Request('https://x/api/ops/reports/weekly', { headers: auth('nope-nope-nope-nope-nope-nope') }))).status).toBe(401)
  })

  it('every route under app/api/ops goes through opsGate, never agentForToken directly', () => {
    const root = join(__dirname, '..', 'app', 'api', 'ops')
    const files: string[] = []
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/^route\.tsx?$/.test(f)) files.push(p)
      }
    }
    walk(root)
    expect(files.length).toBeGreaterThanOrEqual(4)
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).toMatch(/opsGate\(/)
      expect(src, f).not.toMatch(/agentForToken|secretMatches/)
    }
  })
})
