'use server'

/**
 * Server actions behind Settings → Team: add a person by email with a role,
 * change their role, remove them. Owner-only (checked here and again in
 * lib/team/store.ts). Every write runs as the signed-in human, not a fixed
 * 'owner' constant, so the audit log names who actually made the change.
 */
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/db'
import { currentActorId, currentRole } from '@/lib/auth/session'
import { requireRole } from '@/lib/auth/roles'
import { addTeamMember, changeTeamMemberRole, removeTeamMember, TeamError, type TeamMemberRow } from '@/lib/team/store'
import type { Role } from '@/lib/auth/roles'

export interface TeamFormResult {
  ok: boolean
  message?: string
  member?: TeamMemberRow
}

function db() {
  const d = getDb()
  if (!d) throw new Error('The lead database is not connected (DATABASE_URL is not set).')
  return d
}

const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v : ''
}

const fail = (e: unknown): TeamFormResult => ({
  ok: false,
  message: e instanceof TeamError ? e.message : 'That did not work: ' + (e as Error).message,
})

export async function addTeamMemberAction(_prev: TeamFormResult | null, f: FormData): Promise<TeamFormResult> {
  try {
    requireRole(await currentRole(), 'owner')
    const actorId = await currentActorId()
    const role = s(f, 'role') as Role
    const member = await addTeamMember(db(), actorId, { email: s(f, 'email'), displayName: s(f, 'display_name'), role })
    revalidatePath('/settings')
    return { ok: true, message: `Added. They sign in at /login with ${member.email}.`, member }
  } catch (e) {
    return fail(e)
  }
}

export async function changeTeamMemberRoleAction(_prev: TeamFormResult | null, f: FormData): Promise<TeamFormResult> {
  try {
    requireRole(await currentRole(), 'owner')
    const actorId = await currentActorId()
    await changeTeamMemberRole(db(), actorId, s(f, 'actor_id'), s(f, 'role') as Role)
    revalidatePath('/settings')
    return { ok: true, message: 'Role updated.' }
  } catch (e) {
    return fail(e)
  }
}

export async function removeTeamMemberAction(_prev: TeamFormResult | null, f: FormData): Promise<TeamFormResult> {
  try {
    requireRole(await currentRole(), 'owner')
    const actorId = await currentActorId()
    await removeTeamMember(db(), actorId, s(f, 'actor_id'))
    revalidatePath('/settings')
    return { ok: true, message: 'Removed.' }
  } catch (e) {
    return fail(e)
  }
}
