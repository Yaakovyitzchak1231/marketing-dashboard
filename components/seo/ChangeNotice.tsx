import type { ChangeRow } from '@/lib/seo/changes'

/** A stored intent is not evidence that WordPress applied the change. */
export function ChangeNotice({ status }: { status: ChangeRow['status'] }) {
  if (!['applying', 'unknown', 'undoing', 'undo_unknown'].includes(status)) return null
  return <span role="status" className="mt-1 block text-ink-muted">Outcome needs verification on WordPress. The stored before/after record is retained; another write to this page is blocked.</span>
}
