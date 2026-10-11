import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { createTestDb } from './helpers/pglite-db'

// Yaakov's rule (Oct 11, 2026, 3:43 PM): the Owner controls roles. Only an
// owner can add people, change roles or remove people -- in the UI (team
// actions), in the store, and in the database itself (migration 0050), so an
// ops-API op running as an agent, or an editor's action, can't do it either.
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown, role: null as string | null, actor: 'owner' } }))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db, dbConfigured: () => Boolean(holder.db) }))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => holder.role,
  currentActorId: async () => holder.actor,
  currentEmail: async () => null,
}))

import { addTeamMemberAction, changeTeamMemberRoleAction, removeTeamMemberAction } from '@/app/actions/team'
import { addTeamMember, changeTeamMemberRole, parseRole, removeTeamMember, TeamError } from '@/lib/team/store'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb
const as = (role: string | null, actor: string) => {
  holder.role = role
  holder.actor = actor
}
const form = (o: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}
const roleOf = async (id: string) => (await db.query<{ role: string | null; active: boolean }>(`select role, active from lp.actors where id = $1`, [id])).rows[0]

beforeAll(async () => {
  db = await createTestDb()
  holder.db = db
})
afterAll(async () => {
  holder.db = null
  await db.close()
})
beforeEach(async () => {
  await db.tx((q) => q.query(`delete from lp.actors where kind = 'human' and id != 'owner'`), 'owner')
  await db.tx((q) => q.query(`update lp.actors set role = 'owner', active = true where id = 'owner'`), 'owner')
  await db.tx((q) => q.query(
    `insert into lp.actors (id, kind, display_name, email, role, active) values
       ('ed', 'human', 'Ed Itor', 'ed@example.com', 'editor', true),
       ('vi', 'human', 'Vi Ewer', 'vi@example.com', 'viewer', true)`,
  ), 'owner')
})

describe('the database refuses team changes not made by an owner (0050)', () => {
  it('an editor or an agent cannot change a role, add a login, deactivate or delete a person', async () => {
    for (const actor of ['ed', 'tab']) {
      await expect(db.tx((q) => q.query(`update lp.actors set role = 'owner' where id = 'vi'`), actor)).rejects.toThrow(/Only an owner/)
      await expect(
        db.tx((q) => q.query(`insert into lp.actors (id, kind, display_name, email, role, active) values ('x', 'human', 'X', 'x@example.com', 'owner', true)`), actor),
      ).rejects.toThrow(/Only an owner/)
      await expect(db.tx((q) => q.query(`update lp.actors set active = false where id = 'owner'`), actor)).rejects.toThrow(/Only an owner/)
      await expect(db.tx((q) => q.query(`update lp.actors set email = 'me@evil.example' where id = 'vi'`), actor)).rejects.toThrow(/Only an owner/)
      await expect(db.tx((q) => q.query(`delete from lp.actors where id = 'vi'`), actor)).rejects.toThrow(/Only an owner/)
    }
    expect(await roleOf('vi')).toEqual({ role: 'viewer', active: true })
    expect(await roleOf('owner')).toEqual({ role: 'owner', active: true })
  })

  it('an owner can; agent rows and non-team columns are untouched by the rule', async () => {
    await db.tx((q) => q.query(`update lp.actors set role = 'editor' where id = 'vi'`), 'owner')
    expect((await roleOf('vi')).role).toBe('editor')
    // An editor still updates an agent's own row (e.g. last seen) and a human's non-team column.
    await db.tx((q) => q.query(`update lp.actors set last_seen_at = now() where id = 'tab'`), 'ed')
    await db.tx((q) => q.query(`update lp.actors set last_seen_at = now() where id = 'ed'`), 'ed')
  })
})

describe('team actions and store: owner only', () => {
  it('an editor and a viewer are refused add / change role / remove, with nothing changed', async () => {
    for (const [role, actor] of [['editor', 'ed'], ['viewer', 'vi']] as const) {
      as(role, actor)
      const add = await addTeamMemberAction(null, form({ email: 'new@example.com', display_name: 'New', role: 'owner' }))
      expect(add.ok).toBe(false)
      const ch = await changeTeamMemberRoleAction(null, form({ actor_id: actor, role: 'owner' }))
      expect(ch.ok).toBe(false)
      const rm = await removeTeamMemberAction(null, form({ actor_id: 'owner' }))
      expect(rm.ok).toBe(false)
    }
    expect((await db.query(`select 1 from lp.actors where email = 'new@example.com'`)).rows.length).toBe(0)
    expect((await roleOf('ed')).role).toBe('editor')
    expect((await roleOf('vi')).role).toBe('viewer')
    expect((await roleOf('owner')).active).toBe(true)
  })

  it('the store refuses a non-owner caller even if an action forgets to check', async () => {
    await expect(changeTeamMemberRole(db, 'ed', 'vi', 'owner')).rejects.toBeInstanceOf(TeamError)
    await expect(removeTeamMember(db, 'tab', 'vi')).rejects.toBeInstanceOf(TeamError)
  })

  it('an owner adds, changes and removes; roles are checked; a removed person can be added back', async () => {
    as('owner', 'owner')
    const bad = await addTeamMemberAction(null, form({ email: 'a@example.com', display_name: 'A', role: 'admin' }))
    expect(bad).toMatchObject({ ok: false, message: 'Pick a role: Owner, Editor or Viewer.' })
    expect(() => parseRole('superuser')).toThrow(TeamError)
    const add = await addTeamMemberAction(null, form({ email: 'izzy@example.com', display_name: 'Izzy', role: 'editor' }))
    expect(add.ok).toBe(true)
    const id = add.member!.id
    expect((await changeTeamMemberRoleAction(null, form({ actor_id: id, role: 'viewer' }))).ok).toBe(true)
    expect((await roleOf(id)).role).toBe('viewer')
    expect((await removeTeamMemberAction(null, form({ actor_id: id }))).ok).toBe(true)
    expect((await roleOf(id)).active).toBe(false)
    const back = await addTeamMember(db, 'owner', { email: 'izzy@example.com', displayName: 'Izzy', role: 'editor' })
    expect(back).toMatchObject({ id, role: 'editor', active: true })
    const audit = await db.query<{ field: string; changed_by: string }>(
      `select field, changed_by from lp.status_history where entity_type = 'actor' and entity_key = $1 order by id`,
      [id],
    )
    expect(audit.rows.map((r) => r.field)).toEqual(['added', 'role', 'active', 'added'])
    expect(new Set(audit.rows.map((r) => r.changed_by))).toEqual(new Set(['owner']))
  })
})
