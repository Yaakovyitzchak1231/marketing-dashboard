import Link from 'next/link'
import { getDb } from '@/lib/db'
import { currentRole } from '@/lib/auth/session'
import { addTeamMemberAction, changeTeamMemberRoleAction, removeTeamMemberAction } from '@/app/actions/team'
import { TeamSection } from '@/components/settings/TeamSection'
import { DbNotConnected, PageFrame } from '@/components/ops/bits'
import { Card, SectionHeader } from '@/components/dashboard/primitives'
import { listTeamMembers, type TeamMemberRow } from '@/lib/team/store'
import { isUndefinedTable } from '@/lib/db/errors'

export const dynamic = 'force-dynamic'

/** What each role can do, in plain words. Mirrors the checks in app/actions/* and middleware.ts. */
const ROLE_ROWS: { role: string; can: string }[] = [
  { role: 'Owner', can: 'Everything. Only an owner can add people, change roles or remove people, and only an owner can manage settings, API keys, agents and tools, merge or forget records, and change retention, fields, scoring and tags.' },
  { role: 'Editor', can: 'Edit leads, campaigns, segments, lists, files and imports. Cannot manage people, keys, agents or settings.' },
  { role: 'Viewer', can: 'Look at everything, change nothing.' },
]

/**
 * Users & roles: who can sign in, with which role. Owner-only to change
 * (checked in app/actions/team.ts, lib/team/store.ts, and by the database,
 * migration 0050); everyone else sees the list read-only.
 */
export default async function UsersRolesPage() {
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Users & roles" meta="Who can sign in, and what they can do">
        <DbNotConnected what="Users & roles" />
      </PageFrame>
    )
  }

  let members: TeamMemberRow[] = []
  let needsMigration = false
  const role = await currentRole()
  try {
    members = await listTeamMembers(db)
  } catch (e) {
    if (isUndefinedTable(e)) needsMigration = true
    else throw e
  }
  const isOwner = role === 'owner'

  return (
    <PageFrame title="Users & roles" meta="Who can sign in, and what they can do">
      <p className="mb-4 text-xs text-ink-faint">
        <Link href="/settings" prefetch={false} className="underline hover:text-ink">
          Back to Settings
        </Link>
      </p>

      <section className="mb-6">
        <SectionHeader title="People" meta={isOwner ? 'You are an owner: you can add, change and remove people' : 'Only an owner can change this list'} />
        <Card className="p-4">
          {needsMigration ? (
            <p className="text-sm text-ink-muted">Needs migration 0029 — it runs on the next production deploy.</p>
          ) : (
            <TeamSection members={members} isOwner={isOwner} addAction={addTeamMemberAction} roleAction={changeTeamMemberRoleAction} removeAction={removeTeamMemberAction} />
          )}
        </Card>
      </section>

      <section className="mb-6">
        <SectionHeader title="What each role can do" />
        <Card className="p-0">
          <dl data-testid="role-table">
            {ROLE_ROWS.map((r) => (
              <div key={r.role} className="flex gap-4 border-b border-line-soft px-4 py-3 last:border-b-0">
                <dt className="w-16 shrink-0 text-sm font-medium text-ink">{r.role}</dt>
                <dd className="text-sm leading-snug text-ink-muted">{r.can}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </section>
    </PageFrame>
  )
}
