/**
 * Team management: additional human logins with a role, on top of the
 * permanent ALLOWED_USER_EMAIL owner (lib/auth/roles.ts). Humans live in
 * lp.actors (kind='human'), same table as the single owner row today.
 *
 * Every write is owner-only (checked here too, not just in the server
 * action, so a future caller can't skip it) and recorded in the universal
 * audit log, lp.status_history (entity_type 'actor', entity_key = actor id) —
 * the same table and shape lib/settings/store.ts already writes to.
 */
import type { Db, Queryable } from '../db/types'
import type { Role } from '../auth/roles'

export class TeamError extends Error {}

export interface TeamMemberRow {
  id: string
  display_name: string
  email: string
  role: Role
  active: boolean
  created_at: string
}

async function requireOwnerActor(q: Queryable, actorId: string): Promise<void> {
  const r = await q.query<{ role: Role | null }>(
    `select role from lp.actors where id = $1 and kind = 'human' and active limit 1`,
    [actorId],
  )
  const role = r.rows[0]?.role ?? null
  if (role !== 'owner') throw new TeamError('Only an owner can change the team.')
}

async function auditActor(q: Queryable, actorId: string, entityKey: string, field: string, oldValue: string | null, newValue: string | null): Promise<void> {
  await q.query(
    `insert into lp.status_history (entity_type, entity_key, field, old_value, new_value, changed_by, via)
     values ('actor', $1, $2, $3, $4, $5, 'ui')`,
    [entityKey, field, oldValue, newValue, actorId],
  )
}

/** Every human login, owners first, then by name. */
export async function listTeamMembers(q: Queryable): Promise<TeamMemberRow[]> {
  const r = await q.query<TeamMemberRow>(
    `select id, display_name, email, role, active, created_at::text as created_at
       from lp.actors
      where kind = 'human' and email is not null
      order by (role = 'owner') desc, (role = 'editor') desc, display_name asc`,
  )
  return r.rows
}

function slugFromEmail(email: string): string {
  const local = email.split('@')[0]?.toLowerCase() ?? 'person'
  let slug = local.replace(/[^a-z0-9_.-]/g, '-').replace(/^[^a-z0-9]+/, '')
  if (!slug) slug = 'person'
  return slug.slice(0, 40)
}

async function uniqueActorId(q: Queryable, base: string): Promise<string> {
  let candidate = base
  for (let i = 2; i < 100; i++) {
    const r = await q.query<{ id: string }>(`select id from lp.actors where id = $1`, [candidate])
    if (!r.rows.length) return candidate
    candidate = `${base}-${i}`
  }
  throw new TeamError('Could not find a free id for that email.')
}

/** Add a person by email with a role. They sign in with Supabase's existing magic-link / password flow at /login with that email. */
export async function addTeamMember(db: Db, actorId: string, input: { email: string; displayName: string; role: Role }): Promise<TeamMemberRow> {
  const email = input.email.trim().toLowerCase()
  const displayName = input.displayName.trim() || email
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TeamError('That does not look like an email address.')
  if (!displayName) throw new TeamError('Add a name.')
  return db.tx(async (q) => {
    await requireOwnerActor(q, actorId)
    const existing = await q.query<{ id: string }>(`select id from lp.actors where email = $1`, [email])
    if (existing.rows.length) throw new TeamError('That email is already on the team.')
    const id = await uniqueActorId(q, slugFromEmail(email))
    await q.query(
      `insert into lp.actors (id, kind, display_name, harness, active, role, email)
       values ($1, 'human', $2, 'dashboard', true, $3, $4)`,
      [id, displayName, input.role, email],
    )
    await auditActor(q, actorId, id, 'added', null, `${email} (${input.role})`)
    const row = await q.query<TeamMemberRow>(
      `select id, display_name, email, role, active, created_at::text as created_at from lp.actors where id = $1`,
      [id],
    )
    return row.rows[0]
  }, actorId)
}

async function countOtherActiveOwners(q: Queryable, excludingId: string | null): Promise<number> {
  const r = await q.query<{ n: number }>(
    `select count(*)::int as n from lp.actors where kind = 'human' and active and role = 'owner' and id != coalesce($1, '')`,
    [excludingId],
  )
  return r.rows[0]?.n ?? 0
}

/** Change a team member's role. Can't demote the last active DB owner — the env fallback is permanent regardless, but the DB should never be left with zero owners of its own. */
export async function changeTeamMemberRole(db: Db, actorId: string, targetId: string, role: Role): Promise<void> {
  return db.tx(async (q) => {
    await requireOwnerActor(q, actorId)
    const cur = await q.query<{ role: Role | null; active: boolean }>(
      `select role, active from lp.actors where id = $1 and kind = 'human'`,
      [targetId],
    )
    const target = cur.rows[0]
    if (!target) throw new TeamError('No such team member.')
    if (target.role === 'owner' && role !== 'owner') {
      const others = await countOtherActiveOwners(q, targetId)
      if (others === 0) throw new TeamError('Cannot demote the last owner. Make someone else owner first.')
    }
    await q.query(`update lp.actors set role = $1 where id = $2`, [role, targetId])
    await auditActor(q, actorId, targetId, 'role', target.role, role)
  }, actorId)
}

/** Remove (deactivate) a team member. Can't remove the last active DB owner. */
export async function removeTeamMember(db: Db, actorId: string, targetId: string): Promise<void> {
  return db.tx(async (q) => {
    await requireOwnerActor(q, actorId)
    const cur = await q.query<{ role: Role | null; active: boolean }>(
      `select role, active from lp.actors where id = $1 and kind = 'human'`,
      [targetId],
    )
    const target = cur.rows[0]
    if (!target) throw new TeamError('No such team member.')
    if (target.role === 'owner') {
      const others = await countOtherActiveOwners(q, targetId)
      if (others === 0) throw new TeamError('Cannot remove the last owner. Make someone else owner first.')
    }
    await q.query(`update lp.actors set active = false where id = $1`, [targetId])
    await auditActor(q, actorId, targetId, 'active', 'true', 'false')
  }, actorId)
}
