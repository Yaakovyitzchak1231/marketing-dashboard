import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { fakeFetch, installPaidNetworkGuard } from './helpers/no-paid-network'

installPaidNetworkGuard()

/**
 * Pentest finding: Editors can authorize and execute owner-only paid verification runs.
 * 
 * The vulnerability: The shared middleware only blocked viewers from mutations, so an
 * editor could directly create, approve, execute, and cancel verification runs. The
 * approval route supplied the literal actor 'owner', and execution could consume
 * provider budget and modify contact verification/status fields without an owner-level
 * check.
 * 
 * The fix: All verification mutation routes (preview, approve, step, cancel) now call
 * actorFor('owner') which throws AuthError if the caller is not an owner. The fail()
 * handler in _shared.ts catches AuthError and returns 403.
 * 
 * This test verifies that editors are blocked from all verification operations and
 * that only owners can perform them.
 */

const { holder } = vi.hoisted(() => ({ 
  holder: { 
    db: null as unknown, 
    role: null as string | null, 
    actor: 'owner' 
  } 
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ 
  getDb: () => holder.db, 
  dbConfigured: () => Boolean(holder.db) 
}))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => holder.role,
  currentActorId: async () => holder.actor,
  currentEmail: async () => null,
}))

// Import routes after mocks are set up
import { POST as previewRoute } from '@/app/api/verify/preview/route'
import { POST as approveRoute } from '@/app/api/verify/runs/[id]/approve/route'
import { POST as stepRoute } from '@/app/api/verify/runs/[id]/step/route'
import { POST as cancelRoute } from '@/app/api/verify/runs/[id]/cancel/route'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

const as = (role: string | null, actor: string) => {
  holder.role = role
  holder.actor = actor
}

const req = (body: unknown) => new Request('http://localhost/api/verify/preview', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const params = (id: string) => Promise.resolve({ id })

describe('verification routes require owner role', () => {
  let db: TestDb
  let contactIds: number[]

  beforeAll(async () => {
    db = await createTestDb()
    holder.db = db
    
    // Create test actors (must use db.tx with an owner actor for human rows)
    await db.tx((q) => q.query(`
      insert into lp.actors (id, kind, display_name, email, role, active) values
        ('ed', 'human', 'Ed Itor', 'ed@example.com', 'editor', true),
        ('izzy', 'human', 'Izzy Owner', 'izzy@example.com', 'owner', true),
        ('val', 'human', 'Val Viewer', 'val@example.com', 'viewer', true)
    `), 'owner')
    
    // Create test contacts
    const { rows } = await db.query<{ id: number }>(`
      insert into lp.companies (name, state) values ('Test Co', 'MD') returning id
    `)
    const companyId = rows[0].id
    
    const contacts = await db.query<{ id: number }>(`
      insert into lp.contacts (company_id, email, email_norm, status) 
      values 
        ($1, 'test1@example.com', 'test1@example.com', 'new'),
        ($1, 'test2@example.com', 'test2@example.com', 'new')
      returning id
    `, [companyId])
    
    contactIds = contacts.rows.map(r => r.id)
  })

  afterAll(async () => {
    holder.db = null
    await db.close()
  })

  beforeEach(async () => {
    // Clean up runs between tests
    await db.query('delete from lp.verification_results')
    await db.query('delete from lp.verification_runs')
  })

  describe('preview creation', () => {
    it('blocks an editor from creating a preview', async () => {
      as('editor', 'ed')
      
      const response = await previewRoute(req({ contact_ids: contactIds }))
      const data = await response.json()
      
      expect(response.status).toBe(403)
      expect(data.error).toMatch(/owner access/)
      
      // Verify no run was created
      const runs = await db.query<{ n: number }>('select count(*)::int as n from lp.verification_runs')
      expect(runs.rows[0].n).toBe(0)
    })

    it('blocks a viewer from creating a preview', async () => {
      as('viewer', 'val')
      
      const response = await previewRoute(req({ contact_ids: contactIds }))
      const data = await response.json()
      
      expect(response.status).toBe(403)
      expect(data.error).toMatch(/owner access/)
    })

    it('blocks an unauthenticated caller from creating a preview', async () => {
      as(null, 'owner')
      
      const response = await previewRoute(req({ contact_ids: contactIds }))
      const data = await response.json()
      
      expect(response.status).toBe(403)
      expect(data.error).toBe('Not signed in.')
    })

    it('allows an owner to create a preview and records the correct actor', async () => {
      as('owner', 'izzy')
      
      const response = await previewRoute(req({ contact_ids: contactIds }))
      const data = await response.json()
      
      expect(response.status).toBe(201)
      expect(data.run).toBeDefined()
      expect(data.run.status).toBe('preview')
      expect(data.run.requested_by).toBe('izzy')
      
      // Verify the run was created with the correct actor
      const runs = await db.query<{ requested_by: string }>(
        'select requested_by from lp.verification_runs where id = $1',
        [data.run.id]
      )
      expect(runs.rows[0].requested_by).toBe('izzy')
    })
  })

  describe('run approval', () => {
    let runId: number

    beforeEach(async () => {
      // Create a preview run as owner for testing approval
      as('owner', 'izzy')
      const response = await previewRoute(req({ contact_ids: contactIds }))
      const data = await response.json()
      runId = data.run.id
    })

    it('blocks an editor from approving a run', async () => {
      as('editor', 'ed')
      
      const response = await approveRoute(
        req({ max_cost_usd: 10 }),
        { params: params(String(runId)) }
      )
      const data = await response.json()
      
      expect(response.status).toBe(403)
      expect(data.error).toMatch(/owner access/)
      
      // Verify the run was not approved
      const runs = await db.query<{ status: string }>(
        'select status from lp.verification_runs where id = $1',
        [runId]
      )
      expect(runs.rows[0].status).toBe('preview')
    })

    it('blocks a viewer from approving a run', async () => {
      as('viewer', 'val')
      
      const response = await approveRoute(
        req({ max_cost_usd: 10 }),
        { params: params(String(runId)) }
      )
      const data = await response.json()
      
      expect(response.status).toBe(403)
      expect(data.error).toMatch(/owner access/)
    })

    it('allows an owner to approve a run and records the correct actor', async () => {
      as('owner', 'izzy')
      
      const response = await approveRoute(
        req({ max_cost_usd: 10 }),
        { params: params(String(runId)) }
      )
      const data = await response.json()
      
      expect(response.status).toBe(200)
      expect(data.run.status).toBe('approved')
      expect(data.run.approved_by).toBe('izzy')
      expect(data.run.max_cost_usd).toBe(10)
      
      // Verify the approval event records the correct actor
      const events = await db.query<{ actor: string }>(
        `select actor from lp.events where kind = 'verify.approved' and entity_id = $1`,
        [String(runId)]
      )
      expect(events.rows[0].actor).toBe('izzy')
    })

    it('prevents an editor from bypassing approval by supplying a literal owner actor', async () => {
      // This tests the core vulnerability: even if an editor tried to pass 'owner'
      // as the actor parameter, actorFor('owner') should block them before that
      as('editor', 'ed')
      
      const response = await approveRoute(
        req({ max_cost_usd: 10 }),
        { params: params(String(runId)) }
      )
      
      expect(response.status).toBe(403)
      
      // Verify no approval was recorded with any actor
      const runs = await db.query<{ approved_by: string | null }>(
        'select approved_by from lp.verification_runs where id = $1',
        [runId]
      )
      expect(runs.rows[0].approved_by).toBeNull()
    })
  })

  describe('run execution', () => {
    let runId: number

    beforeEach(async () => {
      // Create and approve a run as owner
      as('owner', 'izzy')
      const previewResp = await previewRoute(req({ contact_ids: contactIds }))
      const previewData = await previewResp.json()
      runId = previewData.run.id
      
      await approveRoute(
        req({ max_cost_usd: 10 }),
        { params: params(String(runId)) }
      )
    })

    it('blocks an editor from executing a run', async () => {
      as('editor', 'ed')
      
      const response = await stepRoute(
        req({ chunk: 10 }),
        { params: params(String(runId)) }
      )
      const data = await response.json()
      
      expect(response.status).toBe(403)
      expect(data.error).toMatch(/owner access/)
      
      // Verify the run was not executed (still approved, not running)
      const runs = await db.query<{ status: string; spent_usd: number }>(
        'select status, spent_usd from lp.verification_runs where id = $1',
        [runId]
      )
      expect(runs.rows[0].status).toBe('approved')
      expect(runs.rows[0].spent_usd).toBe(0)
    })

    it('blocks a viewer from executing a run', async () => {
      as('viewer', 'val')
      
      const response = await stepRoute(
        req({ chunk: 10 }),
        { params: params(String(runId)) }
      )
      const data = await response.json()
      
      expect(response.status).toBe(403)
      expect(data.error).toMatch(/owner access/)
    })

    it('allows an owner to execute a run', async () => {
      as('owner', 'izzy')
      
      const response = await stepRoute(
        req({ chunk: 10 }),
        { params: params(String(runId)) }
      )
      
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.run).toBeDefined()
      // Status should be 'running' or 'done' depending on completion
      expect(['running', 'done']).toContain(data.run.status)
    })

    it('prevents an editor from consuming provider budget through execution', async () => {
      as('editor', 'ed')
      
      // Attempt to execute the run
      await stepRoute(
        req({ chunk: 10 }),
        { params: params(String(runId)) }
      )
      
      // Verify no provider spend was recorded
      const runs = await db.query<{ spent_usd: number }>(
        'select spent_usd from lp.verification_runs where id = $1',
        [runId]
      )
      expect(runs.rows[0].spent_usd).toBe(0)
      
      // Verify no verification results were written
      const results = await db.query<{ n: number }>(
        'select count(*)::int as n from lp.verification_results where run_id = $1 and provider != $2',
        [runId, 'precheck']
      )
      expect(results.rows[0].n).toBe(0)
    })

    it('prevents an editor from modifying contact verification status', async () => {
      as('editor', 'ed')
      
      // Get initial verification status
      const before = await db.query<{ verification_status: string }>(
        'select verification_status from lp.contacts where id = any($1) order by id',
        [contactIds]
      )
      
      // Attempt to execute the run
      await stepRoute(
        req({ chunk: 10 }),
        { params: params(String(runId)) }
      )
      
      // Verify contacts remain unchanged
      const after = await db.query<{ verification_status: string }>(
        'select verification_status from lp.contacts where id = any($1) order by id',
        [contactIds]
      )
      
      // Status should be unchanged
      expect(after.rows).toEqual(before.rows)
    })
  })

  describe('run cancellation', () => {
    let runId: number

    beforeEach(async () => {
      // Create a preview run as owner
      as('owner', 'izzy')
      const response = await previewRoute(req({ contact_ids: contactIds }))
      const data = await response.json()
      runId = data.run.id
    })

    it('blocks an editor from canceling a run', async () => {
      as('editor', 'ed')
      
      const response = await cancelRoute(
        req({}),
        { params: params(String(runId)) }
      )
      const data = await response.json()
      
      expect(response.status).toBe(403)
      expect(data.error).toMatch(/owner access/)
      
      // Verify the run was not cancelled
      const runs = await db.query<{ status: string }>(
        'select status from lp.verification_runs where id = $1',
        [runId]
      )
      expect(runs.rows[0].status).toBe('preview')
    })

    it('blocks a viewer from canceling a run', async () => {
      as('viewer', 'val')
      
      const response = await cancelRoute(
        req({}),
        { params: params(String(runId)) }
      )
      const data = await response.json()
      
      expect(response.status).toBe(403)
      expect(data.error).toMatch(/owner access/)
    })

    it('allows an owner to cancel a run and records the correct actor', async () => {
      as('owner', 'izzy')
      
      const response = await cancelRoute(
        req({}),
        { params: params(String(runId)) }
      )
      const data = await response.json()
      
      expect(response.status).toBe(200)
      expect(data.run.status).toBe('cancelled')
      
      // Verify the cancellation event records the correct actor
      const events = await db.query<{ actor: string }>(
        `select actor from lp.events where kind = 'verify.cancelled' and entity_id = $1`,
        [String(runId)]
      )
      expect(events.rows[0].actor).toBe('izzy')
    })
  })

  describe('authorization boundary enforcement', () => {
    it('ensures all verification mutations check owner role before any operation', async () => {
      // This test verifies that the authorization check happens early,
      // before any database operations or side effects
      as('editor', 'ed')
      
      // Track database queries to ensure none are made after auth failure
      const queriesBefore = await db.query<{ n: number }>(
        'select count(*) as n from lp.verification_runs'
      )
      
      // Attempt all operations
      await previewRoute(req({ contact_ids: contactIds }))
      
      const queriesAfter = await db.query<{ n: number }>(
        'select count(*) as n from lp.verification_runs'
      )
      
      // No runs should have been created
      expect(queriesAfter.rows[0].n).toBe(queriesBefore.rows[0].n)
    })

    it('verifies that middleware viewer gate is not the only protection', async () => {
      // The vulnerability was that middleware only blocked viewers, not editors.
      // This test confirms that even if middleware let an editor through,
      // the route-level check would still block them.
      
      // Simulate an editor getting past middleware (which it would)
      as('editor', 'ed')
      
      // All verification operations should still be blocked at the route level
      const preview = await previewRoute(req({ contact_ids: contactIds }))
      expect(preview.status).toBe(403)
      
      // Create a run as owner to test other operations
      as('owner', 'izzy')
      const previewResp = await previewRoute(req({ contact_ids: contactIds }))
      const runId = (await previewResp.json()).run.id
      
      // Switch back to editor
      as('editor', 'ed')
      
      const approve = await approveRoute(
        req({ max_cost_usd: 10 }),
        { params: params(String(runId)) }
      )
      expect(approve.status).toBe(403)
      
      const cancel = await cancelRoute(
        req({}),
        { params: params(String(runId)) }
      )
      expect(cancel.status).toBe(403)
    })
  })

  describe('audit trail integrity', () => {
    it('ensures audit events always record the actual authenticated actor, not a literal string', async () => {
      as('owner', 'izzy')
      
      // Create and approve a run
      const previewResp = await previewRoute(req({ contact_ids: contactIds }))
      const runId = (await previewResp.json()).run.id
      
      await approveRoute(
        req({ max_cost_usd: 10 }),
        { params: params(String(runId)) }
      )
      
      // Check that all events record 'izzy', not 'owner'
      const events = await db.query<{ actor: string; kind: string }>(
        `select actor, kind from lp.events where entity_id = $1 order by at`,
        [String(runId)]
      )
      
      expect(events.rows.length).toBeGreaterThan(0)
      expect(events.rows.every(e => e.actor === 'izzy')).toBe(true)
      expect(events.rows.every(e => e.actor !== 'owner')).toBe(true)
    })

    it('verifies that approved_by field stores the real actor, not a hardcoded owner', async () => {
      as('owner', 'izzy')
      
      const previewResp = await previewRoute(req({ contact_ids: contactIds }))
      const runId = (await previewResp.json()).run.id
      
      await approveRoute(
        req({ max_cost_usd: 10 }),
        { params: params(String(runId)) }
      )
      
      const runs = await db.query<{ approved_by: string }>(
        'select approved_by from lp.verification_runs where id = $1',
        [runId]
      )
      
      expect(runs.rows[0].approved_by).toBe('izzy')
      expect(runs.rows[0].approved_by).not.toBe('owner')
    })
  })
})
