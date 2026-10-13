import { getDb } from '@/lib/db'
import { DbNotConnected, PageFrame } from '@/components/ops/bits'
import { Notice } from '@/components/rules/bits'
import { EventTypesSection } from '@/components/settings/EventTypesSection'
import { listEventTypesWithCounts, type EventTypeListRow } from '@/lib/events/types-store'
import { registerEventTypeAction, setEventTypeActiveAction, updateEventTypeAction } from '@/app/actions/event-types'
import { currentRole } from '@/lib/auth/session'
import { isUndefinedTable } from '@/lib/db/errors'

export const dynamic = 'force-dynamic'

export default async function EventTypesSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const meta = 'The event types track_event accepts. Register your own, relabel it, or switch it off.'
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Event types" meta={meta}>
        <DbNotConnected what="Event types" />
      </PageFrame>
    )
  }
  const role = await currentRole()
  const canEdit = role === 'owner' || role === 'editor'
  let types: EventTypeListRow[] = []
  let needsMigration = false
  try {
    types = await listEventTypesWithCounts(db)
  } catch (e) {
    if (isUndefinedTable(e)) needsMigration = true
    else throw e
  }
  return (
    <PageFrame title="Event types" meta={meta}>
      <Notice error={sp.error} saved={sp.saved} />
      {needsMigration ? (
        <p className="text-sm text-ink-muted">Needs migration 0018 — it runs on the next production deploy.</p>
      ) : (
        <EventTypesSection
          types={types}
          canEdit={canEdit}
          registerAction={registerEventTypeAction}
          updateAction={updateEventTypeAction}
          setActiveAction={setEventTypeActiveAction}
        />
      )}
    </PageFrame>
  )
}
