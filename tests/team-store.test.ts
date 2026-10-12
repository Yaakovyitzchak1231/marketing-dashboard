import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
vi.mock('server-only', () => ({}))

import { createTestDb } from './helpers/pglite-db'
import { addTeamMember, changeTeamMemberRole, listTeamMembers, removeTeamMember, TeamError } from '@/lib/team/store'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('team store (real Postgres via PGlite)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => {
    await db.close()
  })
  beforeEach(async () => {
    // The seeded 'owner' row (migration 0029) must be the sole owner at the
    // start of every test; clear anyone a previous test added.
    await db.tx((q) => q.query(`delete from lp.actors where id != 'owner' and kind = 'human'`), 'owner')
    await db.tx((q) => q.query(`update lp.actors set role = 'owner', active = true where id = 'owner'`), 'owner')
  })

  it('the seeded owner row has role owner after the migration', async () => {
    const members = await listTeamMembers(db)
    expect(members).toEqual([])
    // listTeamMembers only returns rows with an email; the seeded owner row has none yet.
    const r = await db.query<{ role: string }>(`select role from lp.actors where id = 'owner'`)
    expect(r.rows[0]?.role).toBe('owner')
  })

  it('an owner can add a team member by email with a role', async () => {
    const member = await addTeamMember(db, 'owner', { email: 'Izzy@Example.com', displayName: 'Izzy', role: 'editor' })
    expect(member.email).toBe('izzy@example.com')
    expect(member.role).toBe('editor')
    const members = await listTeamMembers(db)
    expect(members.map((m) => m.email)).toContain('izzy@example.com')
  })

  it('add/change/remove are all audited in lp.status_history', async () => {
    const member = await addTeamMember(db, 'owner', { email: 'audit@example.com', displayName: 'Audit Person', role: 'viewer' })
    await changeTeamMemberRole(db, 'owner', member.id, 'editor')
    await removeTeamMember(db, 'owner', member.id)
    const { rows } = await db.query<{ field: string; new_value: string | null; changed_by: string }>(
      `select field, new_value, changed_by from lp.status_history where entity_type = 'actor' and entity_key = $1 order by id`,
      [member.id],
    )
    expect(rows.map((r) => r.field)).toEqual(['added', 'role', 'active'])
    expect(rows.every((r) => r.changed_by === 'owner')).toBe(true)
    expect(rows[1].new_value).toBe('editor')
    expect(rows[2].new_value).toBe('false')
  })

  it('a non-owner cannot add, change, or remove', async () => {
    const viewer = await addTeamMember(db, 'owner', { email: 'v@example.com', displayName: 'V', role: 'viewer' })
    await expect(addTeamMember(db, viewer.id, { email: 'x@example.com', displayName: 'X', role: 'viewer' })).rejects.toThrow(TeamError)
    await expect(changeTeamMemberRole(db, viewer.id, viewer.id, 'owner')).rejects.toThrow(TeamError)
    await expect(removeTeamMember(db, viewer.id, viewer.id)).rejects.toThrow(TeamError)
  })

  it('cannot demote the last owner', async () => {
    await expect(changeTeamMemberRole(db, 'owner', 'owner', 'editor')).rejects.toThrow(/last owner/)
  })

  it('cannot remove the last owner', async () => {
    await expect(removeTeamMember(db, 'owner', 'owner')).rejects.toThrow(/last owner/)
  })

  it('CAN demote/remove an owner once a second owner exists', async () => {
    const second = await addTeamMember(db, 'owner', { email: 'second@example.com', displayName: 'Second', role: 'owner' })
    const third = await addTeamMember(db, 'owner', { email: 'third@example.com', displayName: 'Third', role: 'owner' })
    await changeTeamMemberRole(db, 'owner', second.id, 'editor')
    const r = await db.query<{ role: string }>(`select role from lp.actors where id = $1`, [second.id])
    expect(r.rows[0]?.role).toBe('editor')
    await removeTeamMember(db, 'owner', third.id)
    const t = await db.query<{ active: boolean }>(`select active from lp.actors where id = $1`, [third.id])
    expect(t.rows[0]?.active).toBe(false)
    // 0052: the built-in 'owner' row (the ALLOWED_USER_EMAIL login's actor) is never
    // demoted, even with another owner present: that would lock the permanent owner
    // out of every database owner check.
    const fourth = await addTeamMember(db, 'owner', { email: 'fourth@example.com', displayName: 'Fourth', role: 'owner' })
    await expect(changeTeamMemberRole(db, fourth.id, 'owner', 'editor')).rejects.toThrow(/built-in owner/)
    await expect(changeTeamMemberRole(db, fourth.id, 'owner', 'editor')).rejects.toThrow(TeamError)
  })

  it('rejects a duplicate email and a bad email', async () => {
    await addTeamMember(db, 'owner', { email: 'dup@example.com', displayName: 'Dup', role: 'viewer' })
    await expect(addTeamMember(db, 'owner', { email: 'dup@example.com', displayName: 'Dup2', role: 'viewer' })).rejects.toThrow(/already/)
    await expect(addTeamMember(db, 'owner', { email: 'not-an-email', displayName: 'Bad', role: 'viewer' })).rejects.toThrow(TeamError)
  })
})
