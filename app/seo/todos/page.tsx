import Link from 'next/link'
import { getDb } from '@/lib/db'
import { DbNotConnected } from '@/components/app/PageShell'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { CheckPill, Flash, one } from '@/components/seo/bits'
import { listFixTasks, listSites, type FixTask, type SiteRow } from '@/lib/seo/store'
import type { FixAction } from '@/lib/seo/fixes'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

const ACTION_LABEL: Record<FixAction['type'], string> = {
  set_meta: 'Edit in WordPress',
  add_schema: 'Add to WordPress',
  hide_pages: 'Hide pages',
  create_draft: 'Create draft',
  copy_file: 'Copy & paste',
  manual: 'Steps',
}

function Row({ f }: { f: FixTask }) {
  const sev = f.payload.fix.severity
  return (
    <li className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between" data-testid="seo-fix-row">
      <Link href={`/seo/todos/${f.id}`} className="min-w-0 text-[13px] text-ink hover:text-accent">
        {f.payload.fix.title}
        <span className="text-ink-faint"> · {f.site_name}</span>
      </Link>
      <div className="flex shrink-0 items-center gap-1.5">
        {f.status === 'done' ? <Pill tone="good">done</Pill> : f.status === 'cancelled' ? <Pill tone="neutral">dismissed</Pill> : <CheckPill status={sev === 'fail' ? 'fail' : sev === 'unknown' ? 'unknown' : 'warn'} />}
        <Pill tone="accent">{ACTION_LABEL[f.payload.fix.action.type]}</Pill>
        {f.claimed_by || f.assigned_to ? <Pill tone="neutral">{f.claimed_by ?? f.assigned_to}</Pill> : null}
      </div>
    </li>
  )
}

export default async function SeoTodos({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const db = getDb()
  if (!db) return <DbNotConnected what="The SEO section" />
  const siteId = Number(one(sp.site)) || null
  let open: FixTask[] = []
  let closed: FixTask[] = []
  let sites: SiteRow[] = []
  try {
    ;[open, closed, sites] = await Promise.all([listFixTasks(db, { siteId, open: true }), listFixTasks(db, { siteId, open: false }), listSites(db)])
  } catch {
    return <EmptyNote>Couldn&rsquo;t read the fix list. Run the database migrations.</EmptyNote>
  }
  return (
    <div className="space-y-6">
      <Flash sp={sp} />
      <div className="flex flex-wrap gap-1.5 text-[12px]">
        <Link href="/seo/todos" className={`rounded-card border px-2.5 py-1 ${!siteId ? 'border-accent text-accent' : 'border-line text-ink-muted'}`}>All sites</Link>
        {sites.map((s) => (
          <Link key={s.id} href={`/seo/todos?site=${s.id}`} className={`rounded-card border px-2.5 py-1 ${siteId === s.id ? 'border-accent text-accent' : 'border-line text-ink-muted'}`}>
            {s.name}
          </Link>
        ))}
      </div>
      <section>
        <SectionHeader title="Open" meta="most important first · each one is a task on the Team board that you, Tab or Hermes can pick up" />
        {open.length === 0 ? (
          <EmptyNote>Nothing open. Audits add fixes here automatically.</EmptyNote>
        ) : (
          <Card>
            <ul className="divide-y divide-line">{open.map((f) => <Row key={f.id} f={f} />)}</ul>
          </Card>
        )}
      </section>
      {closed.length ? (
        <section>
          <SectionHeader title="Done and dismissed" />
          <Card>
            <ul className="divide-y divide-line">{closed.slice(0, 30).map((f) => <Row key={f.id} f={f} />)}</ul>
          </Card>
        </section>
      ) : null}
    </div>
  )
}
