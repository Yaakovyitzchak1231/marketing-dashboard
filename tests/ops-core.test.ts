import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import {
  acquireLock, claimTask, completeTask, createTask, decideApproval, failTask, handoffTask, heartbeatTask,
  inbox, memoryPut, memorySearch, parseMentions, releaseLock, requestApproval, comment, OpsError,
} from '@/lib/ops/core'
import { routeToOp, runOp } from '@/lib/ops/dispatch'
import { agentForToken, secretMatches, parseAgentTokens } from '@/lib/ops/auth'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})

describe('tasks: claim with a lease, heartbeat, complete', () => {
  it('two agents asking at once never get the same task', async () => {
    await createTask(db, 'owner', { title: 'Research A', kind: 'research_company' })
    await createTask(db, 'owner', { title: 'Research B', kind: 'research_company' })
    const [x, y] = await Promise.all([claimTask(db, 'tab', { kinds: ['research_company'] }), claimTask(db, 'hermes', { kinds: ['research_company'] })])
    expect(x && y).toBeTruthy()
    expect(x!.id).not.toBe(y!.id)
    expect(await claimTask(db, 'claude', { kinds: ['research_company'] })).toBeNull()
  })

  it('respects assignment: a task for Tab is not claimable by Hermes', async () => {
    const t = await createTask(db, 'owner', { title: 'For Tab only', kind: 'general', assigned_to: 'tab' })
    expect(await claimTask(db, 'hermes', { task_id: t.id })).toBeNull()
    const c = await claimTask(db, 'tab', { task_id: t.id })
    expect(c?.claimed_by).toBe('tab')
    // Tab was notified when it was assigned.
    const n = await inbox(db, 'tab')
    expect(n.some((r) => (r as { kind: string }).kind === 'assigned')).toBe(true)
  })

  it('only the holder can heartbeat or complete; an expired lease frees the task', async () => {
    const t = await createTask(db, 'owner', { title: 'Lease test', kind: 'lease' })
    const c = await claimTask(db, 'tab', { kinds: ['lease'], lease_seconds: 30 })
    expect(c?.id).toBe(t.id)
    await expect(heartbeatTask(db, 'hermes', t.id)).rejects.toThrow(/not claimed by hermes/)
    const hb = await heartbeatTask(db, 'tab', t.id, { progress: { done: 3, of: 10 } })
    expect(hb.status).toBe('running')
    expect((hb.result as { progress: unknown }).progress).toEqual({ done: 3, of: 10 })
    // Simulate Tab going silent past its lease.
    await db.query("update lp.tasks set lease_expires_at = now() - interval '1 second' where id = $1", [t.id])
    const stolen = await claimTask(db, 'hermes', { kinds: ['lease'] })
    expect(stolen?.claimed_by).toBe('hermes')
    await expect(completeTask(db, 'tab', t.id, {})).rejects.toThrow(/held by hermes/)
    const done = await completeTask(db, 'hermes', t.id, { result: { ok: 1 }, report: 'Finished the lease test.' })
    expect(done.status).toBe('done')
    const r = await db.query<{ kind: string }>('select kind from lp.comments where task_id = $1', [t.id])
    expect(r.rows.map((x) => x.kind)).toContain('report')
  })

  it('fail puts a task back in the queue until attempts run out', async () => {
    const t = await createTask(db, 'owner', { title: 'Flaky', kind: 'flaky', max_attempts: 2 })
    await claimTask(db, 'tab', { kinds: ['flaky'] })
    const f1 = await failTask(db, 'tab', t.id, { error: 'site timed out' })
    expect(f1.status).toBe('queued')
    await claimTask(db, 'tab', { kinds: ['flaky'] })
    const f2 = await failTask(db, 'tab', t.id, { error: 'site timed out again' })
    expect(f2.status).toBe('failed')
  })

  it('handoff moves a task to a teammate with a note and notifies them', async () => {
    const t = await createTask(db, 'owner', { title: 'Write openers', kind: 'general', assigned_to: 'tab' })
    await claimTask(db, 'tab', { task_id: t.id })
    const h = await handoffTask(db, 'tab', t.id, { to: 'owner', note: 'Drafted 20, need your pick on tone' })
    expect(h.assigned_to).toBe('owner')
    expect(h.status).toBe('queued')
    const n = await inbox(db, 'owner')
    expect(n.some((r) => (r as { kind: string }).kind === 'handoff')).toBe(true)
  })

  it('refuses a second live task with the same dedupe key', async () => {
    await createTask(db, 'owner', { title: 'R1', kind: 'research_company', dedupe_key: 'research:99' })
    await expect(createTask(db, 'owner', { title: 'R1 again', kind: 'research_company', dedupe_key: 'research:99' })).rejects.toThrow(OpsError)
  })
})

describe('comments and @mentions', () => {
  it('parses mentions and notifies only real actors', async () => {
    expect(parseMentions('hey @Tab and @hermes, email me at a@b.com')).toEqual(['tab', 'hermes'])
    const t = await createTask(db, 'owner', { title: 'Mention test' })
    const c = await comment(db, 'owner', { task_id: t.id, body: '@tab can you take this? cc @nobody' })
    expect(c.mentions).toEqual(['tab'])
    const n = await inbox(db, 'tab')
    expect(n.some((r) => (r as { kind: string; comment_id: number }).kind === 'mention' && (r as { comment_id: number }).comment_id === c.id)).toBe(true)
  })
})

describe('locks: checked out like a library book', () => {
  it('one holder at a time; the holder renews; others see who has it; expiry frees it', async () => {
    const a = await acquireLock(db, 'tab', { resource: 'campaign:abc', note: 'editing step 2' })
    expect(a.ok).toBe(true)
    const b = await acquireLock(db, 'hermes', { resource: 'campaign:abc' })
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.held_by.holder).toBe('tab')
    expect((await acquireLock(db, 'tab', { resource: 'campaign:abc' })).ok).toBe(true)
    expect((await releaseLock(db, 'hermes', { resource: 'campaign:abc' })).released).toBe(false)
    await db.query("update lp.locks set lease_expires_at = now() - interval '1 second' where resource = 'campaign:abc'")
    const c = await acquireLock(db, 'hermes', { resource: 'campaign:abc' })
    expect(c.ok).toBe(true)
    expect((await releaseLock(db, 'owner', { resource: 'campaign:abc', force: true })).released).toBe(true)
  })
  it('rejects a resource without a type prefix', async () => {
    await expect(acquireLock(db, 'tab', { resource: 'abc' })).rejects.toThrow(/resource must look like/)
  })
})

describe('approve-before-send', () => {
  it('only a human decides, never the requester, and the agent sees the answer', async () => {
    const t = await createTask(db, 'owner', { title: 'Send batch', kind: 'send_batch', assigned_to: 'tab' })
    await claimTask(db, 'tab', { task_id: t.id })
    const ap = await requestApproval(db, 'tab', { action: 'send', summary: 'Load 120 leads into campaign Fees', task_id: t.id })
    expect(ap.status).toBe('pending')
    const task = await db.query<{ status: string }>('select status from lp.tasks where id = $1', [t.id])
    expect(task.rows[0].status).toBe('needs_approval')
    await expect(decideApproval(db, 'hermes', ap.id, 'approved')).rejects.toThrow(/only a human/)
    const d = await decideApproval(db, 'owner', ap.id, 'approved', 'go')
    expect(d.status).toBe('approved')
    const got = (await runOp(db, 'tab', 'get_approval', { approval_id: ap.id })) as { status: string }
    expect(got.status).toBe('approved')
    await expect(decideApproval(db, 'owner', ap.id, 'rejected')).rejects.toThrow(/already approved/)
  })
})

describe('per-agent memory', () => {
  it('agents write their own scope or shared; the owner can edit any; every write is logged', async () => {
    await memoryPut(db, 'tab', { key: 'shopify-429', notes: 'Shopify IPs 429 above concurrency 40', source: 'Oct 6 rescrape' })
    await memoryPut(db, 'tab', { scope: 'shared', key: 'voice', notes: 'Short, plain, numbered' })
    await expect(memoryPut(db, 'hermes', { scope: 'tab', key: 'x', notes: 'y' })).rejects.toThrow(/own memory/)
    await memoryPut(db, 'owner', { scope: 'tab', key: 'from-yaakov', notes: 'Never email on Shabbos' })
    const mine = await memorySearch(db, { scopes: ['tab', 'shared'], query: 'shopify' })
    expect(mine.map((m) => m.key)).toEqual(['shopify-429'])
    const hermesView = await memorySearch(db, { scopes: ['hermes', 'shared'] })
    expect(hermesView.map((m) => m.key)).toEqual(['voice'])
    const ev = await db.query<{ n: number }>("select count(*)::int as n from lp.events where kind = 'memory.put'")
    expect(ev.rows[0].n).toBe(3)
  })
})

describe('agents submit research through complete_task', () => {
  it('writes a ResearchResult to the lead with evidence, only on the claimed research task', async () => {
    const co = await db.query<{ id: number }>("insert into lp.companies (name, website_domain) values ('Facet Fine Jewelry', 'facet.example') returning id")
    const cid = co.rows[0].id
    const t = await createTask(db, 'owner', { title: 'Research Facet', kind: 'research_company', company_id: cid, dedupe_key: `research:${cid}` })
    await claimTask(db, 'hermes', { task_id: t.id })
    const research = {
      company_id: cid,
      runner: 'hermes',
      pages_fetched: [{ url: 'https://facet.example/about', status: 200 }],
      emails: [{ email: 'dana@facet.example', evidence_url: 'https://facet.example/about', how: 'mailto', first_name: 'Dana' }],
      people: [{ name: 'Dana Reyes', role: 'owner', evidence_url: 'https://facet.example/about', confidence: 'high', how: 'about page' }],
      phones: [],
      facts: [],
      summary: 'Owner Dana Reyes, email on the About page',
    }
    await expect(runOp(db, 'tab', 'complete_task', { task_id: t.id, result: { research } })).rejects.toThrow(/not claimed by tab/)
    await expect(runOp(db, 'hermes', 'complete_task', { task_id: t.id, result: { research: { ...research, company_id: cid + 999 } } })).rejects.toThrow(/company_id must be/)
    const done = (await runOp(db, 'hermes', 'complete_task', { task_id: t.id, result: { research }, report: 'Found the owner.' })) as { status: string }
    expect(done.status).toBe('done')
    const c = await db.query<{ email_norm: string; company_id: number }>("select email_norm, company_id from lp.contacts where email_norm = 'dana@facet.example'")
    expect(c.rows[0].company_id).toBe(cid)
    const e = await db.query<{ evidence_url: string }>("select evidence_url from lp.enrichment where company_id = $1 and evidence_url is not null limit 1", [cid])
    expect(e.rows[0].evidence_url).toBe('https://facet.example/about')
  })
})

describe('ops API plumbing', () => {
  it('maps REST aliases to ops', () => {
    expect(routeToOp('POST', ['tasks', 'claim'])).toEqual({ op: 'claim_task', args: {} })
    expect(routeToOp('POST', ['tasks', '12', 'heartbeat'])).toEqual({ op: 'heartbeat', args: { task_id: 12 } })
    expect(routeToOp('POST', ['locks', 'acquire'])?.op).toBe('acquire_lock')
    expect(routeToOp('GET', ['approvals', '3'])).toEqual({ op: 'get_approval', args: { approval_id: 3 } })
    expect(routeToOp('DELETE', ['tasks'])).toBeNull()
  })
  it('rejects unknown ops', async () => {
    await expect(runOp(db, 'tab', 'drop_tables', {})).rejects.toThrow(/unknown op/)
    await expect(runOp(db, 'tab', 'constructor', {})).rejects.toThrow(/unknown op/)
  })
  it('authenticates agents by their own token only', () => {
    const raw = 'tab:aaaaaaaaaaaaaaaaaaaaaaaaaaaa,hermes:bbbbbbbbbbbbbbbbbbbbbbbbbbbb,short:abc'
    expect(parseAgentTokens(raw).map((x) => x.id)).toEqual(['tab', 'hermes'])
    expect(agentForToken('Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaa', raw)).toBe('tab')
    expect(agentForToken('Bearer bbbbbbbbbbbbbbbbbbbbbbbbbbbb', raw)).toBe('hermes')
    expect(agentForToken('Bearer abc', raw)).toBeNull()
    expect(agentForToken(null, raw)).toBeNull()
    expect(agentForToken('Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaa', undefined)).toBeNull()
  })
  it('checks webhook secrets in constant time and rejects an unset secret', () => {
    expect(secretMatches('s'.repeat(20), 's'.repeat(20))).toBe(true)
    expect(secretMatches('x'.repeat(20), 's'.repeat(20))).toBe(false)
    expect(secretMatches('anything', undefined)).toBe(false)
    expect(secretMatches('short', 'short')).toBe(false)
  })
})
