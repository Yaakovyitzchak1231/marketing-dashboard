'use client'

import { useActionState, useState } from 'react'
import type { TeamFormResult } from '@/app/actions/team'
import { Pill } from '@/components/dashboard/primitives'
import { primaryBtnCls } from '@/components/ops/bits'
import type { TeamMemberRow } from '@/lib/team/store'
import type { Role } from '@/lib/auth/roles'

type AddAction = (prev: TeamFormResult | null, f: FormData) => Promise<TeamFormResult>
type RoleAction = (prev: TeamFormResult | null, f: FormData) => Promise<TeamFormResult>
type RemoveAction = (prev: TeamFormResult | null, f: FormData) => Promise<TeamFormResult>

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' }
const ROLE_HINT: Record<Role, string> = {
  owner: 'Everything, including settings, keys and the team',
  editor: 'Can edit leads, campaigns and segments',
  viewer: 'Read-only',
}

const selectCls = 'rounded-card border border-line bg-surface px-2 py-1 text-[13px] text-ink focus:border-accent focus:outline-none'

function MemberRow({ member, canManage, isOnlyOwner, roleAction, removeAction }: { member: TeamMemberRow; canManage: boolean; isOnlyOwner: boolean; roleAction: RoleAction; removeAction: RemoveAction }) {
  const [roleState, roleFormAction, rolePending] = useActionState<TeamFormResult | null, FormData>(roleAction, null)
  const [removeState, removeFormAction, removePending] = useActionState<TeamFormResult | null, FormData>(removeAction, null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const lockedOwner = member.role === 'owner' && isOnlyOwner

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft py-3 last:border-b-0" data-testid={`team-member-${member.id}`}>
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-ink">{member.display_name}</p>
        <p className="truncate text-[12px] text-ink-faint">{member.email}</p>
      </div>
      <div className="flex items-center gap-2">
        {canManage ? (
          <form action={roleFormAction} className="flex items-center gap-1.5">
            <input type="hidden" name="actor_id" value={member.id} />
            <select name="role" defaultValue={member.role} className={selectCls} disabled={rolePending || lockedOwner} title={lockedOwner ? 'The last owner cannot be demoted' : ROLE_HINT[member.role]} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
              {(['owner', 'editor', 'viewer'] as Role[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </form>
        ) : (
          <Pill tone="neutral">{ROLE_LABEL[member.role]}</Pill>
        )}
        {canManage ? (
          confirmRemove ? (
            <form action={removeFormAction} className="flex items-center gap-1">
              <input type="hidden" name="actor_id" value={member.id} />
              <button type="submit" disabled={removePending || lockedOwner} className="text-[12px] font-medium text-bad underline disabled:opacity-50">
                {removePending ? 'Removing…' : 'Confirm'}
              </button>
              <button type="button" onClick={() => setConfirmRemove(false)} className="text-[12px] text-ink-faint underline">
                Cancel
              </button>
            </form>
          ) : (
            <button type="button" onClick={() => setConfirmRemove(true)} disabled={lockedOwner} title={lockedOwner ? 'The last owner cannot be removed' : 'Remove'} className="text-[12px] text-ink-faint underline hover:text-bad disabled:opacity-40 disabled:no-underline">
              Remove
            </button>
          )
        ) : null}
      </div>
      {roleState && !roleState.ok ? <p className="w-full text-[12px] text-bad">{roleState.message}</p> : null}
      {removeState && !removeState.ok ? <p className="w-full text-[12px] text-bad">{removeState.message}</p> : null}
    </div>
  )
}

function AddMemberForm({ action }: { action: AddAction }) {
  const [state, formAction, pending] = useActionState<TeamFormResult | null, FormData>(action, null)
  return (
    <form action={formAction} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line-soft pt-3">
      <div>
        <label className="mb-1 block text-[11px] text-ink-faint" htmlFor="team-name">Name</label>
        <input id="team-name" name="display_name" required placeholder="Izzy" className="rounded-card border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none" />
      </div>
      <div>
        <label className="mb-1 block text-[11px] text-ink-faint" htmlFor="team-email">Email</label>
        <input id="team-email" name="email" type="email" required placeholder="izzy@tapdash.co" className="rounded-card border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none" />
      </div>
      <div>
        <label className="mb-1 block text-[11px] text-ink-faint" htmlFor="team-role">Role</label>
        <select id="team-role" name="role" defaultValue="viewer" className={selectCls}>
          {(['owner', 'editor', 'viewer'] as Role[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" disabled={pending} className={primaryBtnCls}>
        {pending ? 'Adding…' : 'Add to team'}
      </button>
      {state ? <Pill tone={state.ok ? 'good' : 'bad'}>{state.message}</Pill> : null}
    </form>
  )
}

/**
 * Settings → Team: everyone with a dashboard login, their role, and adding a
 * new person by email. Owner-only to change; everyone else sees the list.
 * `isOwner` is the signed-in viewer's own role, passed from the server page.
 */
export function TeamSection({ members, isOwner, addAction, roleAction, removeAction }: { members: TeamMemberRow[]; isOwner: boolean; addAction: AddAction; roleAction: RoleAction; removeAction: RemoveAction }) {
  const activeOwners = members.filter((m) => m.active && m.role === 'owner').length
  return (
    <div data-testid="team-section">
      <p className="mb-1 text-[12px] leading-snug text-ink-faint">
        Owner sees and does everything. Editor can edit leads, campaigns and segments. Viewer is read-only. They sign in at <code className="rounded bg-canvas px-1 font-numeric text-[12px] text-ink">/login</code> with the email added here.
      </p>
      {members.filter((m) => m.active).length ? (
        <div>
          {members
            .filter((m) => m.active)
            .map((m) => (
              <MemberRow key={m.id} member={m} canManage={isOwner} isOnlyOwner={m.role === 'owner' && activeOwners <= 1} roleAction={roleAction} removeAction={removeAction} />
            ))}
        </div>
      ) : (
        <p className="text-[12.5px] text-ink-faint">Just you so far.</p>
      )}
      {isOwner ? <AddMemberForm action={addAction} /> : null}
    </div>
  )
}
