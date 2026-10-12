import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { OPS, runOp } from '@/lib/ops/dispatch'
import { EDITOR_OPS_NAMED, OWNER_OPS, VIEWER_OPS, isOwnerActor, requiredRole } from '@/lib/ops/actor-role'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

// Viktor's re-review of #88 at 4a31dc1: the role check on ops keys minted for a PERSON let
// through any op not on its list (a Viewer's key could suppress, unsuppress, update_entity).
// Now deny-by-default: Viewer = read-only allowlist, Editor = every other op, Owner = also the
// owner-only ops. Agent and system keys are not gated by role.
describe('review fix: ops keys for a person are deny-by-default by role', () => {
  let db: TestDb
  let company: number
  beforeAll(async () => {
    db = await createTestDb()
    await db.tx((q) => q.query(`insert into lp.actors (id, kind, display_name, active, role, email) values
      ('vera', 'human', 'Vera', true, 'viewer', 'vera@example.com'),
      ('ed', 'human', 'Ed', true, 'editor', 'ed@example.com'),
      ('olga', 'human', 'Olga', true, 'owner', 'olga@example.com'),
      ('exowner', 'human', 'Ex Owner', false, 'owner', 'exowner@example.com')
      on conflict do nothing`), 'owner')
    await db.query(`insert into lp.actors (id, kind, display_name) values ('hermes', 'agent', 'Hermes') on conflict do nothing`)
    company = await addCompany(db, { name: 'Deny Default Co' })
  })
  afterAll(async () => { await db.close() })

  const status = async (actor: string, op: string, args: Record<string, unknown>) => {
    try {
      await runOp(db, actor, op, args)
      return 200
    } catch (e) {
      return (e as { status?: number }).status ?? 500
    }
  }

  it('every op on the allow/owner lists is a real op, and an unlisted op needs Editor', () => {
    // count_tagged / change_tag ship in #87 (roles); listed ahead so person keys keep them after the merge.
    const names = new Set([...Object.keys(OPS), 'count_tagged', 'change_tag'])
    for (const op of VIEWER_OPS) expect([op, names.has(op)]).toEqual([op, true])
    for (const op of OWNER_OPS) expect([op, names.has(op)]).toEqual([op, true])
    for (const op of EDITOR_OPS_NAMED) expect([op, names.has(op)]).toEqual([op, true])
    for (const op of VIEWER_OPS) expect(OWNER_OPS.has(op)).toBe(false)
    expect(requiredRole('suppress')).toBe('editor')
    expect(requiredRole('some_op_added_next_month')).toBe('editor')
    // #87's tag ops (Viktor, 4:30 PM): count_tagged viewer, change_tag editor, rename/merge owner.
    expect(requiredRole('count_tagged')).toBe('viewer')
    expect(requiredRole('change_tag')).toBe('editor')
    expect(requiredRole('rename_tag')).toBe('owner')
    expect(requiredRole('merge_tags')).toBe('owner')
    for (const op of EDITOR_OPS_NAMED) expect(requiredRole(op)).toBe('editor')
  })

  it("a Viewer's key is refused (403) on suppress, unsuppress and update_entity, and on every op off the read-only list", async () => {
    expect(await status('vera', 'suppress', { email: 'x@viewer.example', reason: 'manual' })).toBe(403)
    expect(await status('vera', 'unsuppress', { email: 'x@viewer.example' })).toBe(403)
    expect(await status('vera', 'update_entity', { type: 'company', id: company, field: 'city', value: 'Nope' })).toBe(403)
    for (const op of Object.keys(OPS)) {
      if (VIEWER_OPS.has(op)) continue
      expect([op, await status('vera', op, {})]).toEqual([op, 403])
    }
    const { rows } = await db.query<{ city: string | null }>('select city from lp.companies where id = $1', [company])
    expect(rows[0].city).not.toBe('Nope')
  })

  it("a Viewer's key can still read", async () => {
    expect(await status('vera', 'whoami', {})).toBe(200)
    expect(await status('vera', 'list_campaigns', {})).toBe(200)
    expect(await status('vera', 'list_suppressions', {})).toBe(200)
  })

  it("an Editor's key works on suppress, unsuppress and update_entity", async () => {
    expect(await status('ed', 'suppress', { email: 'ed@editor.example', reason: 'manual' })).toBe(200)
    expect(await status('ed', 'unsuppress', { email: 'ed@editor.example' })).toBe(200)
    expect(await status('ed', 'update_entity', { type: 'company', id: company, field: 'city', value: 'Edtown' })).toBe(200)
    const { rows } = await db.query<{ city: string | null }>('select city from lp.companies where id = $1', [company])
    expect(rows[0].city).toBe('Edtown')
  })

  it("owner-only ops refuse an Editor's key", async () => {
    for (const op of OWNER_OPS) {
      expect([op, await status('ed', op, {})]).toEqual([op, 403])
    }
  })

  it('a deactivated account is refused even on reads; agents keep working', async () => {
    expect(await status('exowner', 'whoami', {})).toBe(403)
    expect(await status('exowner', 'retention_preview', {})).toBe(403)
    expect(await status('hermes', 'suppress', { email: 'h@agent.example', reason: 'manual' })).toBe(200)
    expect(await status('hermes', 'list_campaigns', {})).toBe(200)
  })

  it('a second human Owner passes the owner checks in retention, forget and merge (no literal "owner" id)', async () => {
    expect(await isOwnerActor(db, 'owner')).toBe(true)
    expect(await isOwnerActor(db, 'olga')).toBe(true)
    expect(await isOwnerActor(db, 'ed')).toBe(false)
    expect(await isOwnerActor(db, 'exowner')).toBe(false)
    expect(await isOwnerActor(db, 'hermes')).toBe(false)

    expect(await status('olga', 'set_retention_policy', { event_category: 'email_opened', keep_days: 120 })).toBe(200)
    expect(await status('olga', 'retention_sweep', {})).toBe(409) // still asks to confirm
    expect(await status('olga', 'retention_sweep', { confirm: true })).toBe(200)

    const { rows } = await db.query<{ id: number }>(
      `insert into lp.contacts (company_id, email, email_norm) values ($1, 'olga-forget@example.com', 'olga-forget@example.com') returning id`,
      [company],
    )
    expect(await status('olga', 'forget_contact', { contact_id: rows[0].id, confirm: 'olga-forget@example.com' })).toBe(200)

    const a = await addCompany(db, { name: 'Olga Keep' })
    const b = await addCompany(db, { name: 'Olga Merge' })
    const merged = (await runOp(db, 'olga', 'merge', { entity: 'company', keep: a, merge: b })) as { kept_id: number }
    expect(merged.kept_id).toBe(a)

    // An Editor is still refused by the op's own owner check, and the runner cannot sweep.
    expect(await status('system', 'retention_sweep', { confirm: true })).toBe(403)
    expect(await status('hermes', 'merge', { entity: 'company', keep: a, merge: b })).toBe(403)
  })

  it('migration 0037 removed the seeded retention_sweep job (the owner confirms each run, so it could never succeed)', async () => {
    const { rows } = await db.query(`select name from lp.jobs where name = 'retention_sweep' or kind = 'retention_sweep'`)
    expect(rows).toEqual([])
  })
})
