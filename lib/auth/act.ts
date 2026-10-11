import 'server-only'
import { currentActorId, currentRole } from './session'
import { requireRole, type Role } from './roles'

/**
 * For a server action that changes data: refuses (AuthError) unless the
 * signed-in account has at least `min`, and returns that account's own
 * lp.actors id, so the audit log names who really did it. Before this, the
 * Phase 2 actions wrote every change as 'owner' and checked no role, so an
 * editor could run owner-only actions (merge, forget, retention, settings) and
 * the audit trail said the owner did it. Viewers are also blocked centrally by
 * middleware.ts; this is the per-action check plan 1.14 asks for on top.
 */
export async function actorFor(min: Role): Promise<string> {
  requireRole(await currentRole(), min)
  return currentActorId()
}
