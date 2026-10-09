import Link from 'next/link'
import { getDb } from '@/lib/db'
import { listActors } from '@/lib/ops/queries'
import { pauseAllState } from '@/lib/ops/pause'
import { pauseAgentAction, pauseAllAction, resumeAgentAction, resumeAllAction } from '@/app/actions/agents'
import { AutoRefresh } from '@/components/ops/AutoRefresh'
import { PauseControl } from '@/components/ops/PauseControl'
import { OnceForm } from '@/components/ops/OnceForm'
import { addAgentAction } from '@/app/actions/connect'
import { Ago, DbNotConnected, PageFrame, Presence, btnCls, inputCls } from '@/components/ops/bits'
import { Card, Pill, SectionHeader } from '@/components/dashboard/primitives'

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
  const [actors, all] = await Promise.all([listActors(db), pauseAllState(db)])
  const now = new Date()
  const agents = actors.filter((a) => a.kind === 'agent')
  const groups: { title: string; list: typeof actors }[] = [
    { title: 'People', list: actors.filter((a) => a.kind === 'human') },
    { title: 'Agents', list: agents },
  ]
  const pausedCount = agents.filter((a) => a.paused_at).length
  return (
    <PageFrame title="Agents" meta="Everyone on the team, human or agent: what they're doing now, what's waiting for them, what they remember">
      <AutoRefresh seconds={20} />
      <section className="mb-6">
        <Card className={`flex flex-wrap items-center gap-3 p-4 ${all ? 'border-warn/40' : ''}`}>
          <div className="min-w-0 flex-1">
            {all ? (
              <>
                <p className="text-[13.5px] font-semibold text-warn">All agents are paused</p>
                <p className="mt-0.5 text-[12.5px] text-ink-muted">
                  By {all.by_name} <Ago at={all.paused_at} now={now} />
                  {all.reason ? ` · “${all.reason}”` : ''}. Every agent request to the ops API is refused; tasks and claims stay as they are.
                </p>
              </>
            ) : (
              <>
                <p className="text-[13.5px] font-semibold text-ink">Stop every agent</p>
                <p className="mt-0.5 text-[12.5px] text-ink-muted">
                  {pausedCount ? `${pausedCount} of ${agents.length} agents paused right now. ` : ''}
                  Pause all refuses every agent&apos;s ops requests until you resume, including agents added later.
                </p>
              </>
            )}
          </div>
          <PauseControl
            paused={Boolean(all)}
            pauseAction={pauseAllAction}
            resumeAction={resumeAllAction}
            pauseLabel="Pause all agents"
            resumeLabel="Resume all agents"
            pauseText="Every agent's requests will be refused until you resume. Their tasks and claims are kept."
            resumeText="Lift pause-all? Agents you paused one by one stay paused."
          />
        </Card>
      </section>
      {groups.map((g) => (
        <section key={g.title} className="mb-6">
          <SectionHeader title={g.title} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {g.list.map((a) => {
              const isAgent = a.kind === 'agent'
              return (
                <Card key={a.id} className={`h-full p-4 transition-colors hover:border-ink-faint ${a.paused_at ? 'border-warn/40' : ''}`}>
                  <Link href={`/agents/${a.id}`} className="block">
                    <div className="flex items-center gap-2">
                      <Presence lastSeen={a.last_seen_at} now={now} />
                      <p className="text-[14px] font-semibold text-ink">{a.display_name}</p>
                      {a.paused_at ? <Pill tone="warn">Paused</Pill> : null}
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
                    {isAgent && !a.channels ? <p className="mt-1 text-[11.5px] text-warn">Not connected: it only hears about new work when it checks in. Open to add a channel.</p> : null}
                  </Link>
                  {isAgent ? (
                    <div className="mt-3 border-t border-line-soft pt-3">
                      {a.paused_at ? (
                        <p className="mb-2 text-[12px] leading-snug text-warn">
                          Paused by {a.paused_by_name ?? 'a person'} <Ago at={a.paused_at} now={now} />
                          {a.pause_reason ? ` · “${a.pause_reason}”` : ''}
                        </p>
                      ) : null}
                      <PauseControl
                        paused={Boolean(a.paused_at)}
                        pauseAction={pauseAgentAction}
                        resumeAction={resumeAgentAction}
                        fields={{ agent_id: a.id }}
                        pauseLabel={`Pause ${a.display_name}`}
                        resumeLabel={`Resume ${a.display_name}`}
                        pauseText={`${a.display_name}'s requests will be refused until you resume. Its ${a.active_tasks} open task${a.active_tasks === 1 ? '' : 's'} stay visible as they are.`}
                        resumeText={`${a.display_name} can work again${all ? ' once pause-all is lifted' : ''}.`}
                      />
                    </div>
                  ) : null}
                </Card>
              )
            })}
          </div>
        </section>
      ))}
      <section className="mb-6">
        <SectionHeader title="Add an agent" />
        <Card className="max-w-md p-3">
          <OnceForm action={addAgentAction} submitLabel="Add agent" buttonClassName={`${btnCls} w-full`}>
            <input name="display_name" required maxLength={80} className={inputCls} placeholder="Name, e.g. Claude Code" />
            <input name="id" required maxLength={63} pattern="[a-z0-9][a-z0-9_.\-]*" className={inputCls} placeholder="Short id, e.g. claude-code (used in @mentions)" />
            <input name="harness" maxLength={40} className={inputCls} placeholder="What runs it (optional), e.g. claude-code, hermes, n8n" />
          </OnceForm>
          <p className="mt-2 text-[11.5px] leading-snug text-ink-faint">Then, on its page: create its API key and choose how it hears about new work (webhook, wake-up ping, email, MCP…). docs/AGENTS_API.md has the details for whoever sets the agent up.</p>
        </Card>
      </section>
      <p className="text-[12px] leading-relaxed text-ink-faint">
        An agent shows as active when it has called the ops API in the last 10 minutes. A paused agent keeps its keys, tasks, claims and memory; its requests get “agent paused by …” until you resume it. Pauses, resumes, new agents, keys and channels are in the activity log.
      </p>
    </PageFrame>
  )
}
