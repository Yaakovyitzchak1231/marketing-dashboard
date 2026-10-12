import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { emitLeadEvent } from '@/lib/events/emit'
import { runOp } from '@/lib/ops/dispatch'
import { runDueJourneys } from '@/lib/journeys/runner'
import { validateGraph, GraphError } from '@/lib/journeys/graph'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

const INTERACTION = {
  start: 'check',
  nodes: [
    { id: 'check', kind: 'branch', paths: [
      { label: 'clicked', to: 'hot' },
      { label: 'opened', to: 'warm' },
      { label: 'no-open', to: 'cold' },
    ] },
    { id: 'hot', kind: 'note' },
    { id: 'warm', kind: 'note' },
    { id: 'cold', kind: 'note' },
  ],
}

describe('branch nodes (plan 3.5)', () => {
  let db: TestDb
  let co: number

  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Branch Co', domain: 'branch.example', city: 'Towson' })
  })
  afterAll(async () => db.close())

  async function enroll(name: string, graph: unknown, company = co, contact?: number) {
    const j = await runOp(db, 'owner', 'journey_upsert', { name }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const target = contact != null ? { contact_id: contact } : { company_id: company }
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, ...target }) as { results: { run_id: number }[] }
    return en.results[0].run_id
  }

  async function nodeOf(runId: number) {
    const { rows } = await db.query<{ node_id: string; status: string }>('select node_id, status from lp.journey_runs where id = $1', [runId])
    return rows[0]
  }

  it('takes clicked over opened, and no-open when neither happened', async () => {
    const quiet = await enroll('No open', INTERACTION)
    await runDueJourneys(db)
    expect(await nodeOf(quiet)).toMatchObject({ node_id: 'cold', status: 'done' })

    const opener = await addCompany(db, { name: 'Opener', domain: 'open.example', city: 'Towson' })
    const opened = await enroll('Opened', INTERACTION, opener)
    await emitLeadEvent(db, { type: 'email_opened', company_id: opener, source: 'test' })
    await runDueJourneys(db)
    expect(await nodeOf(opened)).toMatchObject({ node_id: 'warm', status: 'done' })

    const clicker = await addCompany(db, { name: 'Clicker', domain: 'click.example', city: 'Towson' })
    const clicked = await enroll('Clicked', INTERACTION, clicker)
    await emitLeadEvent(db, { type: 'email_opened', company_id: clicker, source: 'test' })
    await emitLeadEvent(db, { type: 'email_link_clicked', company_id: clicker, source: 'test' })
    await runDueJourneys(db)
    expect(await nodeOf(clicked)).toMatchObject({ node_id: 'hot', status: 'done' })
  })

  it('if/else takes yes when the event happened, else no', async () => {
    const graph = {
      start: 'gate',
      nodes: [
        { id: 'gate', kind: 'branch', config: { if: { event: 'reply_received' } }, paths: [
          { label: 'yes', to: 'thanks' },
          { label: 'no', to: 'nudge' },
        ] },
        { id: 'thanks', kind: 'note' },
        { id: 'nudge', kind: 'note' },
      ],
    }
    const no = await enroll('No reply', graph)
    await runDueJourneys(db)
    expect(await nodeOf(no)).toMatchObject({ node_id: 'nudge' })

    const who = await addCompany(db, { name: 'Replied', domain: 'replied.example', city: 'Towson' })
    const yes = await enroll('Replied', graph, who)
    await emitLeadEvent(db, { type: 'reply_received', company_id: who, source: 'test' })
    await runDueJourneys(db)
    expect(await nodeOf(yes)).toMatchObject({ node_id: 'thanks' })
  })

  it('ignores an open that happened before entry even when it was backfilled after (occurred_at, not recorded_at)', async () => {
    const who = await addCompany(db, { name: 'Backfilled', domain: 'backfill.example', city: 'Towson' })
    const runId = await enroll('Backfill', INTERACTION, who)
    // reconcile writes the real past time as occurred_at; recorded_at is now()
    await emitLeadEvent(db, { type: 'email_opened', company_id: who, source: 'backfill', occurred_at: new Date(Date.now() - 24 * 3600_000) })
    await emitLeadEvent(db, { type: 'email_link_clicked', company_id: who, source: 'backfill', occurred_at: new Date(Date.now() - 24 * 3600_000) })
    await runDueJourneys(db)
    expect(await nodeOf(runId)).toMatchObject({ node_id: 'cold', status: 'done' })

    const ifGraph = {
      start: 'gate',
      nodes: [
        { id: 'gate', kind: 'branch', config: { if: { event: 'reply_received' } }, paths: [{ label: 'yes', to: 'y' }, { label: 'no', to: 'n' }] },
        { id: 'y', kind: 'note' }, { id: 'n', kind: 'note' },
      ],
    }
    const other = await addCompany(db, { name: 'Old reply', domain: 'oldreply.example', city: 'Towson' })
    const r2 = await enroll('Old reply', ifGraph, other)
    await emitLeadEvent(db, { type: 'reply_received', company_id: other, source: 'backfill', occurred_at: new Date(Date.now() - 24 * 3600_000) })
    await runDueJourneys(db)
    expect(await nodeOf(r2)).toMatchObject({ node_id: 'n' })
  })

  it("since 'node' measures from arrival at the branch; the default measures from journey entry", async () => {
    const graph = (since?: string) => ({
      start: 'gate',
      nodes: [
        { id: 'gate', kind: 'branch', config: since ? { since } : {}, paths: [{ label: 'opened', to: 'y' }, { label: 'no-open', to: 'n' }] },
        { id: 'y', kind: 'note' }, { id: 'n', kind: 'note' },
      ],
    })
    for (const [since, expected] of [[undefined, 'y'], ['journey', 'y'], ['node', 'n']] as const) {
      const who = await addCompany(db, { name: `Since ${since ?? 'default'}`, domain: `since-${since ?? 'default'}.example`, city: 'Towson' })
      const runId = await enroll(`Since ${since ?? 'default'}`, graph(since), who)
      await db.query(`update lp.journey_runs set entered_at = now() - interval '2 hours' where id = $1`, [runId])
      await emitLeadEvent(db, { type: 'email_opened', company_id: who, source: 'test', occurred_at: new Date(Date.now() - 3600_000) })
      await runDueJourneys(db)
      expect(await nodeOf(runId), `since=${since}`).toMatchObject({ node_id: expected })
    }
  })

  describe('whose events count (same rule as 3.7)', () => {
    const IF_REPLY = {
      start: 'gate',
      nodes: [
        { id: 'gate', kind: 'branch', config: { if: { event: 'reply_received' } }, paths: [{ label: 'yes', to: 'y' }, { label: 'no', to: 'n' }] },
        { id: 'y', kind: 'note' }, { id: 'n', kind: 'note' },
      ],
    }

    // Events carry company_id as well as contact_id, like the email path (emit's resolve) fills both.
    async function pair(tag: string) {
      const company = await addCompany(db, { name: `Pair ${tag}`, domain: `pair-${tag}.example`, city: 'Towson' })
      const mine = await addContact(db, company, `me@pair-${tag}.example`)
      const colleague = await addContact(db, company, `colleague@pair-${tag}.example`)
      return { company, mine, colleague }
    }

    it("a contact run ignores a colleague's click, and takes clicked on its own click", async () => {
      const a = await pair('click-a')
      const runA = await enroll('Colleague click', INTERACTION, a.company, a.mine)
      await emitLeadEvent(db, { type: 'email_link_clicked', company_id: a.company, contact_id: a.colleague, source: 'test' })
      await emitLeadEvent(db, { type: 'email_opened', company_id: a.company, contact_id: a.colleague, source: 'test' })
      await runDueJourneys(db)
      expect(await nodeOf(runA)).toMatchObject({ node_id: 'cold', status: 'done' })

      const b = await pair('click-b')
      const runB = await enroll('Own click', INTERACTION, b.company, b.mine)
      await emitLeadEvent(db, { type: 'email_link_clicked', company_id: b.company, contact_id: b.colleague, source: 'test' })
      await emitLeadEvent(db, { type: 'email_link_clicked', company_id: b.company, contact_id: b.mine, source: 'test' })
      await runDueJourneys(db)
      expect(await nodeOf(runB)).toMatchObject({ node_id: 'hot', status: 'done' })
    })

    it("an if.event branch on a contact run ignores a colleague's reply, and counts its own", async () => {
      const a = await pair('reply-a')
      const runA = await enroll('Colleague reply', IF_REPLY, a.company, a.mine)
      await emitLeadEvent(db, { type: 'reply_received', company_id: a.company, contact_id: a.colleague, source: 'test' })
      await runDueJourneys(db)
      expect(await nodeOf(runA)).toMatchObject({ node_id: 'n', status: 'done' })

      const b = await pair('reply-b')
      const runB = await enroll('Own reply', IF_REPLY, b.company, b.mine)
      await emitLeadEvent(db, { type: 'reply_received', company_id: b.company, contact_id: b.mine, source: 'test' })
      await runDueJourneys(db)
      expect(await nodeOf(runB)).toMatchObject({ node_id: 'y', status: 'done' })
    })

    it("a company run still counts the company's events, including a contact's", async () => {
      const a = await pair('company-run')
      const run = await enroll('Company run', IF_REPLY, a.company)
      await emitLeadEvent(db, { type: 'reply_received', company_id: a.company, contact_id: a.colleague, source: 'test' })
      await runDueJourneys(db)
      expect(await nodeOf(run)).toMatchObject({ node_id: 'y', status: 'done' })
    })
  })

  it('if/else never treats NULL or a missing value as equal to an empty string', async () => {
    const nullCity = await addCompany(db, { name: 'No City', domain: 'nocity.example', city: null })
    const graph = (equals: unknown) => ({
      start: 'gate',
      nodes: [
        { id: 'gate', kind: 'branch', config: { if: { entity: 'company', field: 'city', equals } }, paths: [{ label: 'yes', to: 'y' }, { label: 'no', to: 'n' }] },
        { id: 'y', kind: 'note' }, { id: 'n', kind: 'note' },
      ],
    })
    const blank = await enroll('Null vs empty', graph(''), nullCity)
    await runDueJourneys(db)
    expect(await nodeOf(blank)).toMatchObject({ node_id: 'n' })

    const explicit = await enroll('Null explicit', graph(null), nullCity)
    await runDueJourneys(db)
    expect(await nodeOf(explicit)).toMatchObject({ node_id: 'y' })

    const known = await addCompany(db, { name: 'Has City', domain: 'hascity.example', city: 'Towson' })
    const notNull = await enroll('Null vs value', graph(null), known)
    await runDueJourneys(db)
    expect(await nodeOf(notNull)).toMatchObject({ node_id: 'n' })
    const match = await enroll('Value match', graph('Towson'), known)
    await runDueJourneys(db)
    expect(await nodeOf(match)).toMatchObject({ node_id: 'y' })
  })

  describe('branch config is validated', () => {
    const YN = [{ label: 'yes', to: 'a' }, { label: 'no', to: 'b' }]
    const g = (config: Record<string, unknown> | undefined, paths: { label: string; to: string }[]) => ({
      start: 'x',
      nodes: [{ id: 'x', kind: 'branch', ...(config ? { config } : {}), paths }, { id: 'a', kind: 'note' }, { id: 'b', kind: 'note' }],
    })
    const errorsOf = (graph: unknown): string[] => {
      try {
        validateGraph(graph)
        return []
      } catch (e) {
        if (e instanceof GraphError) return e.errors
        throw e
      }
    }
    const reject = (graph: unknown, re: RegExp) => expect(errorsOf(graph).join('\n')).toMatch(re)

    it('accepts the documented shapes', () => {
      expect(errorsOf(g({ if: { event: 'reply_received' } }, YN))).toEqual([])
      expect(errorsOf(g({ if: { entity: 'contact', field: 'status', equals: null } }, [{ label: 'true', to: 'a' }, { label: 'else', to: 'b' }]))).toEqual([])
      expect(errorsOf(g({ since: 'node' }, [{ label: 'opened', to: 'a' }, { label: 'else', to: 'b' }]))).toEqual([])
      expect(errorsOf(g(undefined, [{ label: 'clicked', to: 'a' }, { label: 'no-open', to: 'b' }]))).toEqual([])
    })

    it('rejects an unknown entity, a non-whitelisted field, and a spec with nothing to check', () => {
      reject(g({ if: { entity: 'lead', field: 'stage', equals: 'new' } }, YN), /entity must be/)
      reject(g({ if: { entity: 'company', field: 'website', equals: 'x' } }, YN), /if\.field for a company must be one of/)
      reject(g({ if: { entity: 'company', field: 'stage; drop table lp.companies', equals: 'x' } }, YN), /if\.field/)
      reject(g({ if: {} }, YN), /if needs \{event\}/)
      reject(g({ if: { entity: 'company', field: 'stage' } }, YN), /equals is required/)
      reject(g({ if: { event: 'x', entity: 'company', field: 'stage', equals: 'new' } }, YN), /not both/)
      reject(g({ if: { event: 'Reply Received' } }, YN), /if\.event must be/)
      reject(g({ if: { event: 'reply_received', evnt: 1 } }, YN), /unknown key 'evnt'/)
      reject(g({ if: 'reply_received' }, YN), /if must be/)
    })

    it('rejects graphs missing the path labels the mode needs, with no last-path fallthrough', () => {
      reject(g({ if: { event: 'reply_received' } }, [{ label: 'yes', to: 'a' }]), /'no' \(or 'else'\)/)
      reject(g({ if: { event: 'reply_received' } }, [{ label: 'no', to: 'b' }]), /'yes' \(or 'true'\)/)
      reject(g({ if: { event: 'reply_received' } }, [{ label: 'replied', to: 'a' }, { label: 'quiet', to: 'b' }]), /'yes'[\s\S]*'no'/)
      reject(g(undefined, [{ label: 'opened', to: 'a' }]), /fallback path/)
      reject(g(undefined, [{ label: 'engaged', to: 'a' }, { label: 'no-open', to: 'b' }]), /'opened' and\/or 'clicked'/)
      reject(g(undefined, [{ label: 'x', to: 'a' }, { label: 'y', to: 'b' }]), /'opened' and\/or 'clicked'/)
    })

    it("only accepts since 'node' or 'journey'", () => {
      reject(g({ since: 'entry' }, [{ label: 'opened', to: 'a' }, { label: 'else', to: 'b' }]), /since must be one of: journey, node/)
      reject(g({ since: 'Node' }, [{ label: 'opened', to: 'a' }, { label: 'else', to: 'b' }]), /since must be one of/)
      reject(g({ since: 7 }, YN), /since must be one of/)
      expect(errorsOf(g({ since: 'journey' }, [{ label: 'opened', to: 'a' }, { label: 'else', to: 'b' }]))).toEqual([])
    })

    it('rejects unknown config keys', () => {
      reject(g({ iff: { event: 'x' } }, YN), /unknown config key 'iff'/)
    })

    it('publishing a bad branch is rejected and stores no version', async () => {
      const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Bad branch publish' }) as { id: number }
      const bad = g({ if: { entity: 'company', field: 'website', equals: 'x' } }, YN)
      await expect(runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: bad })).rejects.toMatchObject({ status: 400 })
      await expect(runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: g({ since: 'forever' }, YN) })).rejects.toMatchObject({ status: 400 })
      await expect(runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: g({ if: { event: 'reply_received' } }, [{ label: 'a', to: 'a' }]) })).rejects.toMatchObject({ status: 400 })
      const { rows } = await db.query('select 1 from lp.journey_versions where journey_id = $1', [j.id])
      expect(rows).toHaveLength(0)
      await expect(runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })).rejects.toMatchObject({ status: 409 })
      // journey_validate reports the same problems without saving
      const v = await runOp(db, 'owner', 'journey_validate', { graph: bad }) as { ok: boolean; errors: string[] }
      expect(v.ok).toBe(false)
      expect(v.errors.join(' ')).toMatch(/if\.field/)
    })
  })
})
