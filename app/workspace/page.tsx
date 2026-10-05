import { SharedWorkspace } from '@/components/shared-workspace'

export const dynamic = 'force-dynamic'

/**
 * First run of this section. There is no revision store on this page yet,
 * so the lists are empty on purpose — not a failed fetch rewritten as empty.
 * A failed fetch is `null`, and the component says the load failed.
 *
 * Owner comes from the allow-list env when it is a real address. The
 * fail-closed placeholder is not a person, so it is not shown.
 * shared stays false until a grant exists. Flipping the badge without one
 * would claim a share that was never recorded.
 */
function ownerFromEnv(): string | null {
  const email = process.env.ALLOWED_USER_EMAIL
  if (!email || email === 'unset@invalid.local') return null
  return email
}

export default function WorkspacePage() {
  return (
    <SharedWorkspace
      ownerEmail={ownerFromEnv()}
      lastActor={null}
      shared={false}
      revisions={[]}
      approvals={[]}
      comments={[]}
      approvalNeeded={false}
    />
  )
}
