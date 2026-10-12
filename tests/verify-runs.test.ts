import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { fakeFetch, installPaidNetworkGuard } from './helpers/no-paid-network'
import { approveRun, cancelRun, createPreview, getRun, listRuns, stepRun, type VerifyEnv } from '@/lib/verify/runs'
import { estimateCost, getPricing, parseCeiling, suggestCeiling } from '@/lib/verify/pricing'
import { nextContactStatus, runWaterfall } from '@/lib/verify/waterfall'
import { createPrechecker, type DnsResolver } from '@/lib/verify/precheck'

installPaidNetworkGuard()

type TestDb = Awaited<ReturnType<typeof createTestDb>>

/** The lp.actors id every test call acts as (seeded by the base migration). */
const ACTOR = 'owner'

const MV_KEY = 'mv_TEST_KEY_123456'
const ZB_KEY = 'zb_TEST_KEY_654321'

const err = (code: string) => Object.assign(new Error(code), { code })
const resolver: DnsResolver = {
  async resolveMx(d) {
    if (d === 'deadshop.com') throw err('ENOTFOUND')
    return [{ exchange: `mx.${d}`, priority: 10 }]
  },
  async resolve4() {
    throw err('ENODATA')
  },
  async resolve6() {
    throw err('ENODATA')
  },
}

/** MV answers by local part: ok / catchall / unknown / bad; ZB answers by a table. */
function vendors(zbAnswers: Record<string, string> = {}) {
  return fakeFetch((u) => {
    if (u.hostname === 'api.millionverifier.com') {
      const email = u.searchParams.get('email') ?? ''
      const local = email.split('@')[0]
      const result = local.startsWith('catchall') ? 'catch_all' : local.startsWith('unknown') ? 'unknown' : local.startsWith('bad') ? 'invalid' : 'ok'
      return { body: { email, result, subresult: '', credits: 1000, error: '' } }
    }
    if (u.hostname === 'api.zerobounce.net') {
      const email = u.searchParams.get('email') ?? ''
      return { body: { address: email, status: zbAnswers[email] ?? 'valid', sub_status: '' } }
    }
    throw new Error('unexpected host ' + u.hostname)
  })
}

function env(over: Partial<VerifyEnv> = {}, zb: Record<string, string> = {}): VerifyEnv & { fetch: ReturnType<typeof vendors> } {
  const f = vendors(zb)
  return {
    keys: { millionverifier: MV_KEY, zerobounce: ZB_KEY },
    pricing: getPricing({}),
    resolver,
    fetch: f,
    ...over,
  } as VerifyEnv & { fetch: ReturnType<typeof vendors> }
}

async function seed(db: TestDb, emails: string[], extra: { state?: string; status?: string } = {}) {
  const { rows } = await db.query<{ id: number }>(
    `insert into lp.companies (name, state) values ('Gem Co ' || $1, $2) returning id`,
    [Math.random().toString(36).slice(2), extra.state ?? 'MD'],
  )
  const ids: number[] = []
  for (const e of emails) {
    const r = await db.query<{ id: number }>(
      `insert into lp.contacts (company_id, email, email_norm, status) values ($1, $2, lower($2), $3) returning id`,
      [rows[0].id, e, extra.status ?? 'new'],
    )
    ids.push(r.rows[0].id)
  }
  return ids
}

describe('preview math (pure)', () => {
  it('estimates MV for every precheck pass and ZB for the expected share', () => {
    const e = estimateCost(100, getPricing({}))
    expect(e).toMatchObject({ mv_checks: 100, zb_checks: 25, mv_cost_usd: 0.39, zb_cost_usd: 0.3225, total_usd: 0.7125 })
    expect(e.math).toContain('100 × $0.0039')
  })

  it('contacts MillionVerifier already called catch-all/unknown go straight to ZeroBounce in the estimate', () => {
    const e = estimateCost(100, getPricing({}), 20)
    expect(e).toMatchObject({ mv_checks: 80, zb_direct: 20, zb_checks: 40 })
    expect(e.total_usd).toBeCloseTo(80 * 0.0039 + 40 * 0.0129, 4)
  })

  it('the approve box: suggested ceiling = estimate + 20%, rounded up to the cent; bad input is not a number', () => {
    expect(suggestCeiling(0.7125)).toBe('0.86')
    expect(suggestCeiling(null)).toBe('')
    expect(parseCeiling('$1.50')).toBe(1.5)
    expect(parseCeiling('')).toBeNull()
    expect(parseCeiling('-1')).toBeNull()
    expect(parseCeiling('abc')).toBeNull()
  })

  it('env overrides pricing; nonsense env values fall back to the defaults', () => {
    const p = getPricing({ MV_COST_PER_CHECK: '0.0024', ZB_COST_PER_CHECK: 'abc', VERIFY_ZB_SHARE_ESTIMATE: '0.5' })
    expect(p).toMatchObject({ mvCostPerCheck: 0.0024, zbCostPerCheck: 0.0129, zbShareEstimate: 0.5 })
    expect(p.source).toEqual({ mv: 'MV_COST_PER_CHECK', zb: 'default', share: 'VERIFY_ZB_SHARE_ESTIMATE' })
  })
})

describe('waterfall decisions (pure)', () => {
  const ctx = (f: ReturnType<typeof vendors>, keys = { millionverifier: MV_KEY, zerobounce: ZB_KEY }) => ({
    prechecker: createPrechecker({ resolver }),
    keys,
    pricing: getPricing({}),
    fetch: f,
  })

  it('MV ok -> valid, ZeroBounce never called', async () => {
    const f = vendors()
    const o = await runWaterfall('owner@gemco.com', ctx(f))
    expect(o).toMatchObject({ final: 'valid', decided_by: 'millionverifier', cost_usd: 0.0039 })
    expect(f.calls.some((c) => c.includes('zerobounce'))).toBe(false)
  })

  it('MV catch_all -> ZeroBounce; ZB valid -> valid', async () => {
    const f = vendors({ 'catchall@gemco.com': 'valid' })
    const o = await runWaterfall('catchall@gemco.com', ctx(f))
    expect(o.steps.map((s) => s.provider)).toEqual(['precheck', 'millionverifier', 'zerobounce'])
    expect(o).toMatchObject({ final: 'valid', decided_by: 'zerobounce', cost_usd: 0.0168 })
  })

  it('MV unknown -> ZB unknown (free): MV word stands, ZB not billed', async () => {
    const f = vendors({ 'unknown@gemco.com': 'unknown' })
    const o = await runWaterfall('unknown@gemco.com', ctx(f))
    expect(o).toMatchObject({ final: 'unknown', decided_by: 'millionverifier', cost_usd: 0.0039 })
    expect(o.steps[2]).toMatchObject({ provider: 'zerobounce', cost_usd: 0 })
  })

  it('precheck invalid -> no paid call at all', async () => {
    const f = vendors()
    const o = await runWaterfall('owner@deadshop.com', ctx(f))
    expect(o).toMatchObject({ final: 'invalid', decided_by: 'precheck', cost_usd: 0 })
    expect(f.calls).toEqual([])
  })

  it('missing keys stop at that tier and say so', async () => {
    const f = vendors()
    expect(await runWaterfall('owner@gemco.com', ctx(f, { millionverifier: '', zerobounce: ZB_KEY }))).toMatchObject({
      final: null,
      stop: 'mv_key_missing',
      note: 'MillionVerifier key not set',
    })
    expect(await runWaterfall('catchall@gemco.com', ctx(f, { millionverifier: MV_KEY, zerobounce: '' }))).toMatchObject({
      final: 'catch_all',
      decided_by: 'millionverifier',
      stop: 'zb_key_missing',
      note: 'ZeroBounce key not set',
    })
    expect(f.calls.some((c) => c.includes('zerobounce'))).toBe(false)
  })

  it('sheet status moves only for contacts not yet in a campaign', () => {
    expect(nextContactStatus('new', 'valid')).toBe('valid-ready')
    expect(nextContactStatus('guessed-hold', 'valid')).toBe('valid-ready')
    expect(nextContactStatus('catch-all-hold', 'valid')).toBe('valid-ready')
    expect(nextContactStatus('verifying', 'invalid')).toBe('rejected')
    expect(nextContactStatus('new', 'catch_all')).toBe('catch-all-hold')
    expect(nextContactStatus('new', 'unknown')).toBe('new')
    expect(nextContactStatus('in-Instantly', 'invalid')).toBe('in-Instantly')
    expect(nextContactStatus('replied', 'invalid')).toBe('replied')
  })
})

describe('verification runs (PGlite)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => {
    await db.close()
  })
  beforeEach(async () => {
    await db.query('delete from lp.verification_results')
    await db.query('delete from lp.verification_runs')
    await db.query('delete from lp.contacts')
    await db.query('delete from lp.companies')
    await db.query('delete from lp.locks')
    await db.query('delete from lp.approvals')
    // status_history is append-only since 0017; test cleanup uses the maintenance hatch.
    await db.query("select set_config('lp.maintenance', 'on', false)")
    await db.query('delete from lp.status_history')
  })

  it('preview runs only the free check, records it, and stores the estimate', async () => {
    const ids = await seed(db, ['owner@gemco.com', 'catchall@gemco.com', 'x@deadshop.com', 'y@mailinator.com'])
    const e = env()
    const run = await createPreview(db, { actor: ACTOR, contact_ids: ids }, e)
    expect(e.fetch.calls).toEqual([]) // nothing paid during preview
    expect(run).toMatchObject({ status: 'preview', contact_count: 4, precheck_pass: 2, est_mv_checks: 2, est_zb_checks: 1 })
    expect(run.est_cost_usd).toBeCloseTo(2 * 0.0039 + 0.0129, 4)
    expect(run.summary?.precheck).toMatchObject({ checked: 4, passed: 2, invalid: 2, by_result: { ok: 2, no_mx: 1, disposable: 1 } })
    const { rows } = await db.query<{ n: number }>(`select count(*)::int n from lp.verification_results where run_id = $1 and provider = 'precheck'`, [run.id])
    expect(rows[0].n).toBe(4)
    const ev = await db.query<{ summary: string }>(`select summary from lp.events where kind = 'verify.preview' and entity_id = $1`, [String(run.id)])
    expect(ev.rows[0].summary).toMatch(/^Verification preview #\d+: 4 leads checked free, 2 failed the free check, 2 would go to MillionVerifier/)
    // Contacts are untouched until a human approves.
    const c = await db.query<{ verification_status: string }>(`select verification_status from lp.contacts`)
    expect(c.rows.every((r) => r.verification_status === 'unverified')).toBe(true)
  })

  it('selects by filter and skips recently verified contacts unless forced', async () => {
    await seed(db, ['a@gemco.com', 'b@gemco.com'], { state: 'MD' })
    await seed(db, ['c@gemco.com'], { state: 'NY' })
    await db.query(`update lp.contacts set verification_status = 'valid', verified_at = now(), verified_by = 'millionverifier' where email_norm = 'b@gemco.com'`)
    const md = await createPreview(db, { actor: ACTOR, filter: { state: 'md' } }, env())
    expect(md.contact_count).toBe(1)
    expect(md.summary?.selection?.skipped.recently_verified).toBe(1)
    const forced = await createPreview(db, { actor: ACTOR, filter: { state: 'MD' }, force: true }, env())
    expect(forced.contact_count).toBe(2)
  })

  it('refuses to step before approval; approval is recorded as the owner', async () => {
    const ids = await seed(db, ['owner@gemco.com'])
    const run = await createPreview(db, { actor: ACTOR, contact_ids: ids }, env())
    await expect(stepRun(db, run.id, env(), { actor: ACTOR })).rejects.toThrow(/not been approved/)
    const ok = await approveRun(db, run.id, 1, ACTOR)
    expect(ok).toMatchObject({ status: 'approved', approved_by: 'owner', max_cost_usd: 1 })
    const ev = await db.query<{ actor: string; summary: string }>(
      `select actor, summary from lp.events where kind = 'verify.approved' and entity_id = $1`,
      [String(run.id)],
    )
    expect(ev.rows[0].actor).toBe('owner')
    expect(ev.rows[0].summary).toMatch(/^Approved verification run #\d+: 1 lead, estimate ≈\$0\.02, ceiling \$1\.00$/)
  })

  it('a full run: writes every step, updates contacts, spends, logs, finishes', async () => {
    const ids = await seed(db, ['owner@gemco.com', 'catchall@gemco.com', 'catchall2@gemco.com', 'bad@gemco.com', 'x@deadshop.com'])
    const e = env({}, { 'catchall@gemco.com': 'valid', 'catchall2@gemco.com': 'catch-all' })
    const run = await createPreview(db, { actor: ACTOR, contact_ids: ids }, e)
    await approveRun(db, run.id, 5, ACTOR)
    const rep = await stepRun(db, run.id, e, { actor: ACTOR, chunk: 10 })
    expect(rep).toMatchObject({ done: true, processed_now: 5, halted: null, paused: null })
    expect(rep.run.status).toBe('done')
    // 4 MV checks + 2 ZB checks
    expect(rep.run.spent_usd).toBeCloseTo(4 * 0.0039 + 2 * 0.0129, 4)
    const c = await db.query<{ email_norm: string; verification_status: string; verified_by: string; status: string }>(
      `select email_norm, verification_status, verified_by, status from lp.contacts order by id`,
    )
    expect(c.rows).toEqual([
      { email_norm: 'owner@gemco.com', verification_status: 'valid', verified_by: 'millionverifier', status: 'valid-ready' },
      { email_norm: 'catchall@gemco.com', verification_status: 'valid', verified_by: 'zerobounce', status: 'valid-ready' },
      { email_norm: 'catchall2@gemco.com', verification_status: 'catch_all', verified_by: 'zerobounce', status: 'catch-all-hold' },
      { email_norm: 'bad@gemco.com', verification_status: 'invalid', verified_by: 'millionverifier', status: 'rejected' },
      { email_norm: 'x@deadshop.com', verification_status: 'invalid', verified_by: 'precheck', status: 'rejected' },
    ])
    const vr = await db.query<{ provider: string; n: number }>(
      `select provider, count(*)::int n from lp.verification_results where run_id = $1 group by 1 order by 1`,
      [run.id],
    )
    expect(vr.rows).toEqual([
      { provider: 'millionverifier', n: 4 },
      { provider: 'precheck', n: 5 },
      { provider: 'zerobounce', n: 2 },
    ])
    // No key anywhere in what we stored.
    const raw = await db.query<{ raw: unknown }>(`select raw from lp.verification_results`)
    expect(JSON.stringify(raw.rows)).not.toContain(MV_KEY)
    expect(JSON.stringify(raw.rows)).not.toContain(ZB_KEY)
    // History names the approver.
    const h = await db.query<{ changed_by: string }>(`select distinct changed_by from lp.status_history where field = 'verification_status'`)
    expect(h.rows).toEqual([{ changed_by: 'owner' }])
    const ev = await db.query<{ summary: string }>(`select summary from lp.events where kind = 'verify.done' and entity_id = $1`, [String(run.id)])
    expect(ev.rows[0].summary).toMatch(/^Verification run #\d+ finished: 5 leads, 2 valid, 2 invalid, 1 catch-all, 0 unknown\/risky, \$0\.04 spent$/)
    expect(rep.run.summary?.checks).toEqual({ millionverifier: 4, zerobounce: 2, precheck_rejected: 1 })
  })

  it('steps through a run in chunks and never pays twice for the same contact', async () => {
    const ids = await seed(db, Array.from({ length: 7 }, (_, i) => `p${i}@gemco.com`))
    const e = env()
    const run = await createPreview(db, { actor: ACTOR, contact_ids: ids }, e)
    await approveRun(db, run.id, 1, ACTOR)
    const a = await stepRun(db, run.id, e, { actor: ACTOR, chunk: 3 })
    expect(a).toMatchObject({ processed_now: 3, done: false })
    const b = await stepRun(db, run.id, e, { actor: ACTOR, chunk: 3 })
    const c = await stepRun(db, run.id, e, { actor: ACTOR, chunk: 3 })
    expect([b.processed_now, c.processed_now, c.done]).toEqual([3, 1, true])
    expect(e.fetch.calls.length).toBe(7)
    await expect(stepRun(db, run.id, e, { actor: ACTOR })).rejects.toThrow(/is done/)
  })

  it('stops before crossing the cost ceiling, then continues when the ceiling is raised', async () => {
    const ids = await seed(db, Array.from({ length: 10 }, (_, i) => `c${i}@gemco.com`))
    const e = env()
    const run = await createPreview(db, { actor: ACTOR, contact_ids: ids }, e)
    // Worst case per contact = MV + ZB = 0.0168. A $0.05 ceiling allows 2 at a time: 0.0168*3 = 0.0504 > 0.05.
    await approveRun(db, run.id, 0.05, ACTOR)
    const r1 = await stepRun(db, run.id, e, { actor: ACTOR, chunk: 10, concurrency: 1 })
    expect(r1.done).toBe(false)
    expect(r1.paused).toMatch(/ceiling/)
    expect(r1.run.spent_usd).toBeLessThanOrEqual(0.05)
    expect(r1.run.status).toBe('running')
    const callsAtPause = e.fetch.calls.length
    // Stepping again without raising: nothing new happens, nothing spent.
    const r2 = await stepRun(db, run.id, e, { actor: ACTOR, chunk: 10, concurrency: 1 })
    expect(r2.processed_now).toBe(0)
    expect(e.fetch.calls.length).toBe(callsAtPause)
    await expect(approveRun(db, run.id, 0.001, ACTOR)).rejects.toThrow(/below what this run already spent/)
    await approveRun(db, run.id, 1, ACTOR)
    const r3 = await stepRun(db, run.id, e, { actor: ACTOR, chunk: 10, concurrency: 4 })
    expect(r3.done).toBe(true)
    expect(r3.run.spent_usd).toBeCloseTo(10 * 0.0039, 4)
    const paused = await db.query<{ n: number }>(`select count(*)::int n from lp.events where kind = 'verify.paused' and entity_id = $1`, [String(run.id)])
    expect(paused.rows[0].n).toBe(1)
  })

  it("the sheet's MillionVerifier catch-all answers skip MV and go straight to ZeroBounce", async () => {
    const ids = await seed(db, ['catchall@gemco.com', 'owner@gemco.com'])
    // As the Lead Master import writes them: MV's word from the sheet.
    await db.query(
      `update lp.contacts set verification_status = 'catch_all', verified_by = 'sheet_import', verified_at = now() - interval '2 days', status = 'catch-all-hold' where id = $1`,
      [ids[0]],
    )
    const e = env({}, { 'catchall@gemco.com': 'valid' })
    const run = await createPreview(db, { actor: ACTOR, contact_ids: ids }, e)
    expect(run.contact_count).toBe(2) // not skipped as "recently verified": ZeroBounce never looked
    expect(run.summary?.estimate).toMatchObject({ mv_checks: 1, zb_direct: 1, zb_checks: 2 })
    await approveRun(db, run.id, 1, ACTOR)
    await stepRun(db, run.id, e, { actor: ACTOR })
    const hosts = e.fetch.calls.map((c) => `${new URL(c).hostname} ${new URL(c).searchParams.get('email')}`)
    expect(hosts.sort()).toEqual(['api.millionverifier.com owner@gemco.com', 'api.zerobounce.net catchall@gemco.com'])
    const c = await db.query<{ verification_status: string; verified_by: string; status: string }>(
      `select verification_status, verified_by, status from lp.contacts where id = $1`,
      [ids[0]],
    )
    expect(c.rows[0]).toEqual({ verification_status: 'valid', verified_by: 'zerobounce', status: 'valid-ready' })
  })

  it('a ceiling of $0 refuses every paid call (only free results are applied)', async () => {
    const ids = await seed(db, ['x@deadshop.com', 'owner@gemco.com'])
    const e = env()
    const run = await createPreview(db, { actor: ACTOR, contact_ids: ids }, e)
    await approveRun(db, run.id, 0, ACTOR)
    const r = await stepRun(db, run.id, e, { actor: ACTOR })
    expect(e.fetch.calls).toEqual([])
    expect(r.run.spent_usd).toBe(0)
    expect(r.paused).toMatch(/ceiling/)
  })

  it('with no MillionVerifier key: free results applied, the rest left unverified and said plainly', async () => {
    const ids = await seed(db, ['x@deadshop.com', 'owner@gemco.com'])
    const e = env({ keys: { millionverifier: null, zerobounce: null } })
    const run = await createPreview(db, { actor: ACTOR, contact_ids: ids }, e)
    expect(run.est_cost_usd).toBe(0)
    expect(run.summary?.warnings?.[0]).toMatch(/MillionVerifier key not set/)
    await approveRun(db, run.id, 1, ACTOR)
    const r = await stepRun(db, run.id, e, { actor: ACTOR })
    expect(r.done).toBe(true)
    expect(r.run.summary?.not_checked?.mv_key_missing).toBe(1)
    const c = await db.query<{ verification_status: string }>(`select verification_status from lp.contacts order by id`)
    expect(c.rows.map((x) => x.verification_status)).toEqual(['invalid', 'unverified'])
    const ev = await db.query<{ summary: string }>(`select summary from lp.events where kind = 'verify.done' and entity_id = $1`, [String(run.id)])
    expect(ev.rows[0].summary).toContain('1 not checked (MillionVerifier key not set)')
  })

  it('a provider refusing the key halts the run as failed, without touching the contact', async () => {
    const ids = await seed(db, ['owner@gemco.com', 'two@gemco.com'])
    const f = fakeFetch(() => ({ body: { error: 'Invalid API key' } }))
    const e = { ...env(), fetch: f }
    const run = await createPreview(db, { actor: ACTOR, contact_ids: ids }, e)
    await approveRun(db, run.id, 1, ACTOR)
    const r = await stepRun(db, run.id, e, { actor: ACTOR, concurrency: 1 })
    expect(r.halted).toMatch(/MillionVerifier: Invalid API key/)
    expect(r.run.status).toBe('failed')
    expect(r.run.spent_usd).toBe(0)
    const c = await db.query<{ verification_status: string }>(`select verification_status from lp.contacts`)
    expect(c.rows.every((x) => x.verification_status === 'unverified')).toBe(true)
  })

  it('one step at a time per run (a second concurrent step is refused)', async () => {
    const ids = await seed(db, ['owner@gemco.com'])
    const run = await createPreview(db, { actor: ACTOR, contact_ids: ids }, env())
    await approveRun(db, run.id, 1, ACTOR)
    await db.query(`insert into lp.locks (resource, holder, lease_expires_at) values ($1, 'system', now() + interval '1 minute')`, [`verify-run:${run.id}`])
    await expect(stepRun(db, run.id, env(), { actor: ACTOR })).rejects.toThrow(/already being processed/)
    await db.query(`delete from lp.locks`)
  })

  it('cancel stops a run; runs list newest first', async () => {
    const ids = await seed(db, ['owner@gemco.com'])
    const r1 = await createPreview(db, { actor: ACTOR, contact_ids: ids }, env())
    const r2 = await createPreview(db, { actor: ACTOR, contact_ids: ids }, env())
    expect((await cancelRun(db, r1.id, ACTOR)).status).toBe('cancelled')
    await expect(approveRun(db, r1.id, 1, ACTOR)).rejects.toThrow(/cancelled/)
    expect((await listRuns(db)).map((r) => r.id)).toEqual([r2.id, r1.id])
    expect(await getRun(db, 999999)).toBeNull()
  })

  it('previewer, approver and the person who runs a step are each recorded under their own id', async () => {
    // Two owners: one previews, a second approves, a third runs the step. Nothing may be attributed to the approver by default.
    await db.tx(
      (q) =>
        q.query(`
          insert into lp.actors (id, kind, display_name, email, role, active) values
            ('pat', 'human', 'Pat Preview', 'pat@example.com', 'owner', true),
            ('amy', 'human', 'Amy Approve', 'amy@example.com', 'owner', true),
            ('sam', 'human', 'Sam Step', 'sam@example.com', 'owner', true)
          on conflict (id) do nothing`),
      'owner',
    )
    const ids = await seed(db, ['owner@gemco.com', 'bad@gemco.com'])
    const e = env()
    const run = await createPreview(db, { actor: 'pat', contact_ids: ids }, e)
    expect(run.requested_by).toBe('pat')
    const approved = await approveRun(db, run.id, 5, 'amy')
    expect(approved.requested_by).toBe('pat')
    expect(approved.approved_by).toBe('amy')
    // lp.lead_events is append-only and shared across tests: only look at rows this step wrote.
    const baseline = (await db.query<{ n: string }>(`select coalesce(max(id), 0)::text as n from lp.lead_events`)).rows[0].n
    const rep = await stepRun(db, run.id, e, { actor: 'sam' })
    expect(rep.done).toBe(true)

    // The audit feed: preview by pat, approval by amy (carrying both ids), completion by sam.
    const ev = await db.query<{ kind: string; actor: string; data: Record<string, unknown> | null }>(
      `select kind, actor, data from lp.events where entity_id = $1 and kind like 'verify.%' order by id`,
      [String(run.id)],
    )
    expect(ev.rows.map((r) => [r.kind, r.actor])).toEqual([
      ['verify.preview', 'pat'],
      ['verify.approved', 'amy'],
      ['verify.done', 'sam'],
    ])
    expect(ev.rows[1].data).toMatchObject({ requested_by: 'pat', approved_by: 'amy' })

    // The per-lead stream and the status history name the person who ran the step, not the approver.
    const le = await db.query<{ actor: string }>(`select distinct actor from lp.lead_events where source = 'verify' and id > $1::bigint`, [baseline])
    expect(le.rows).toEqual([{ actor: 'sam' }])
    const h = await db.query<{ changed_by: string }>(`select distinct changed_by from lp.status_history where field = 'verification_status'`)
    expect(h.rows).toEqual([{ changed_by: 'sam' }])
    // verified_by on the contact is the PROVIDER that decided, not a person; it must not be touched by this change.
    const c = await db.query<{ verified_by: string }>(`select verified_by from lp.contacts order by id`)
    expect(c.rows.map((r) => r.verified_by)).toEqual(['millionverifier', 'millionverifier'])
  })
})
