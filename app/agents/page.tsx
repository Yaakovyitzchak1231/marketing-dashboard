import Link from 'next/link'
import { getDb } from '@/lib/db'
import { listActors } from '@/lib/ops/queries'
import { AutoRefresh } from '@/components/ops/AutoRefresh'
import { Ago, DbNotConnected, PageFrame, Presence } from '@/components/ops/bits'
import { Card, SectionHeader } from '@/components/dashboard/primitives'

export const dynamic = 'force-dynamic'

export default async function AgentsPage() {
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Agents" meta="Who is working on what">
        <DbNotConnected />
      </PageFrame>
    )
  }
  const actors = await listActors(db)
  const now = new Date()
  const groups: { title: string; list: typeof actors }[] = [
    { title: 'People', list: actors.filter((a) => a.kind === 'human') },
    { title: 'Agents', list: actors.filter((a) => a.kind === 'agent') },
  ]
  return (
    <PageFrame title="Agents" meta="Everyone on the team, human or agent: what they're doing now, what's waiting for them, what they remember">
      <AutoRefresh seconds={20} />
      {groups.map((g) => (
        <section key={g.title} className="mb-6">
          <SectionHeader title={g.title} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {g.list.map((a) => (
              <Link key={a.id} href={`/agents/${a.id}`} className="block">
                <Card className="h-full p-4 transition-colors hover:border-ink-faint">
                  <div className="flex items-center gap-2">
                    <Presence lastSeen={a.last_seen_at} now={now} />
                    <p className="text-[14px] font-semibold text-ink">{a.display_name}</p>
                    <span className="ml-auto text-[11.5px] text-ink-faint">
                      seen <Ago at={a.last_seen_at} now={now} />
                    </span>
                  </div>
                  <p className="mt-1.5 min-h-[18px] text-[12.5px] leading-snug text-ink-muted">{a.status_note ?? (a.active_tasks ? '' : 'Nothing in hand')}</p>
                  <dl className="mt-3 grid grid-cols-4 gap-2 text-[11.5px]">
                    {[
                      ['On it', a.active_tasks],
                      ['Waiting', a.queued_for],
                      ['Checked out', a.locks_held],
                      ['Notes', a.memory_notes],
                    ].map(([k, v]) => (
                      <div key={k as string}>
                        <dt className="text-ink-faint">{k}</dt>
                        <dd className="mt-0.5 text-[14px] font-medium tabular-nums text-ink">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  {a.unread ? <p className="mt-2 text-[11.5px] text-accent">{a.unread} unread</p> : null}
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ))}
      <p className="text-[12px] leading-relaxed text-ink-faint">
        An agent shows as active when it has called the ops API in the last 10 minutes. Add a new agent by inserting a row in lp.actors and giving it its own token in OPS_AGENT_TOKENS.
      </p>
    </PageFrame>
  )
}
