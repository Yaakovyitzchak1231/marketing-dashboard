import type { Role } from '@/lib/auth/roles'
import { btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { isValueChangePayload } from '@/lib/edit/ask-change'

/**
 * Approve / Reject for a non-Instantly approval on Activity. "Ask to change"
 * requests for Instantly numbers are Owner-only (lib/ops/core.ts decideApproval
 * refuses anyone else), so non-owners get a plain note instead of buttons that
 * would only fail. The server check stays the backstop.
 */
export function ApprovalDecideForm({
  approvalId,
  payload,
  role,
  action,
}: {
  approvalId: number
  payload: unknown
  role: Role | null
  action: (fd: FormData) => void | Promise<void>
}) {
  if (isValueChangePayload(payload) && role !== 'owner') {
    return <p className="text-[12px] text-ink-muted">Waiting for an owner to decide.</p>
  }
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="approval_id" value={approvalId} />
      <input name="note" className={inputCls} placeholder="Note (optional)" />
      <div className="flex gap-2">
        <button name="decision" value="approved" className={primaryBtnCls} type="submit">Approve</button>
        <button name="decision" value="rejected" className={btnCls} type="submit">Reject</button>
      </div>
    </form>
  )
}
