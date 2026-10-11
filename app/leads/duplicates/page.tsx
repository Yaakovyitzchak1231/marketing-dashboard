import Link from 'next/link'
import { getDb } from '@/lib/db'
import { PageShell, DbNotConnected } from '@/components/app/PageShell'
import { findCandidates, type MergeEntity } from '@/lib/merge/candidates'
import { DuplicatesClient } from '@/components/leads/DuplicatesClient'

export const dynamic = 'force-dynamic'

function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={`rounded-full border px-2.5 py-1 text-[12px] ${active ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-muted hover:text-ink'}`}
    >
      {children}
    </Link>
  )
}

export default async function DuplicatesPage({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  const { entity: rawEntity } = await searchParams
  const entity: MergeEntity = rawEntity === 'contact' ? 'contact' : 'company'
  const db = getDb()
  if (!db) {
    return (
      <PageShell title="Duplicates">
        <DbNotConnected what="Duplicate detection" />
      </PageShell>
    )
  }
  let candidates: Awaited<ReturnType<typeof findCandidates>> = []
  let needsMigration = false
  try {
    candidates = await findCandidates(db, entity, 50)
  } catch (e) {
    if (/does not exist/i.test((e as Error).message ?? '')) needsMigration = true
    else throw e
  }
  if (needsMigration) {
    return (
      <PageShell title="Duplicates">
        <div className="rounded-lg border border-line bg-paper p-4 text-[13px] text-ink-muted">
          Needs migration 0026 — it runs on the next production deploy.
        </div>
      </PageShell>
    )
  }
  return (
    <PageShell
      title="Duplicates"
      meta="Likely duplicate stores and contacts, found by matching website, phone, name + address or email — pick which details to keep, then merge."
      actions={
        <Link href="/leads" prefetch={false} className="text-[12px] text-ink-faint hover:text-ink">
          ← All leads
        </Link>
      }
    >
      <div className="mb-4 flex gap-2">
        <TabLink href="/leads/duplicates?entity=company" active={entity === 'company'}>Stores</TabLink>
        <TabLink href="/leads/duplicates?entity=contact" active={entity === 'contact'}>Contacts</TabLink>
      </div>
      <DuplicatesClient key={entity} entity={entity} initial={candidates} />
    </PageShell>
  )
}
