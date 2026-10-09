import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db'
import { actorDetail, listActors, listProjects, sharedMemory } from '@/lib/ops/queries'
import { createTaskAction, markReadAction, memoryDeleteAction, memoryPutAction } from '@/app/actions/ops'
import { pauseAgentAction, resumeAgentAction } from '@/app/actions/agents'
import { pauseAllState } from '@/lib/ops/pause'
import { PauseControl } from '@/components/ops/PauseControl'
import { AutoRefresh } from '@/components/ops/AutoRefresh'
import { Ago, DbNotConnected, PageFrame, Presence, btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { TaskCard } from '@/components/ops/TaskCard'
import { ConnectPanel } from '@/components/ops/ConnectPanel'
import { DeliveryChip } from '@/components/ops/DeliveryChip'
import type { DeliveryStatus } from '@/lib/notify/deliver'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'

export const dynamic = 'force-dynamic'

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Agent">
        <DbNotConnected />
      </PageFrame>
    )
  }
  const id = (await params).id
  const [d, projects, shared, all, actors] = await Promise.all([actorDetail(db, id), listProjects(db), sharedMemory(db), pauseAllState(db), listActors(db)])
  if (!d) notFound()
  const { actor: a } = d
  const now = new Date()
  const isAgent = a.kind === 'agent'

  return (
    <PageFrame
      title={a.display_name}
      meta={
        <span className="inline-flex items-center gap-1.5">
          <Presence lastSeen={a.last_seen_at} now={now} />
          {a.paused_at ? <Pill tone="warn">Paused</Pill> : null}
          {isAgent ? 'Agent' : 'Person'} · last seen <Ago at={a.last_seen_at} now={now} />
          {a.status_note ? ` · “${a.status_note}”` : ''}
        </span>
      }
      actions={<Link href="/agents" className={btnCls}>All agents</Link>}
    >
      <AutoRefresh seconds={15} />
      {isAgent ? (
        <Card className={`mb-5 flex flex-wrap items-center gap-3 p-4 ${a.paused_at || all ? 'border-warn/40' : ''}`}>
          <div className="min-w-0 flex-1 text-[12.5px] leading-snug">
            {a.paused_at ? (
              <p className="text-warn">
                <span className="font-semibold">Paused</span> by {a.paused_by_name ?? 'a person'} <Ago at={a.paused_at} now={now} />
                {a.pause_reason ? ` · “${a.pause_reason}”` : ''}. Its requests are refused; the tasks and claims below stay as they are.
              </p>
            ) : all ? (
              <p className="text-warn">All agents are paused (by {all.by_name}). Resume them on the Agents page.</p>
            ) : (
              <p className="text-ink-muted">Running. Pausing refuses every request {a.display_name} makes until you resume; its tasks, claims and memory are kept.</p>
            )}
          </div>
          <PauseControl
            paused={Boolean(a.paused_at)}
            pauseAction={pauseAgentAction}
            resumeAction={resumeAgentAction}
            fields={{ agent_id: a.id }}
            pauseLabel={`Pause ${a.display_name}`}
            resumeLabel={`Resume ${a.display_name}`}
            pauseText={`${a.display_name}'s requests will be refused until you resume. Its ${d.current.length} open task${d.current.length === 1 ? '' : 's'} stay visible as they are.`}
            resumeText={`${a.display_name} can work again${all ? ' once pause-all is lifted' : ''}.`}
          />
        </Card>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-6">
          <section>
            <SectionHeader title="Working on now" meta={<span className="tabular-nums">{d.current.length}</span>} />
            {d.current.length ? <div className="grid gap-2 sm:grid-cols-2">{d.current.map((t) => <TaskCard key={t.id} t={t} now={now} />)}</div> : <Card><EmptyNote>Nothing in hand right now.</EmptyNote></Card>}
          </section>
          <section>
            <SectionHeader title="Waiting for them" meta={<span className="tabular-nums">{d.queued.length}</span>} />
            {d.queued.length ? <div className="grid gap-2 sm:grid-cols-2">{d.queued.map((t) => <TaskCard key={t.id} t={t} now={now} />)}</div> : <Card><EmptyNote>No queued tasks assigned.</EmptyNote></Card>}
          </section>
          <section>
            <SectionHeader title="Reports" />
            <Card className="divide-y divide-line-soft">
              {d.reports.length ? (
                d.reports.map((t) => (
                  <div key={t.id} className="px-4 py-3 text-[13px]">
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <Link href={`/team/${t.id}`} className="font-medium text-ink hover:text-accent">{t.title}</Link>
                      <span className={`text-[11.5px] ${t.status === 'failed' ? 'text-bad' : 'text-ink-faint'}`}>{t.status === 'failed' ? 'failed' : 'done'} <Ago at={t.finished_at} now={now} /></span>
                    </p>
                    {t.report || t.error ? <p className="mt-1 line-clamp-4 whitespace-pre-wrap leading-relaxed text-ink-muted">{t.report ?? t.error}</p> : null}
                  </div>
                ))
              ) : (
                <EmptyNote>No finished tasks yet.</EmptyNote>
              )}
            </Card>
          </section>
          <section>
            <SectionHeader title={`${a.display_name}'s memory`} meta={<span className="tabular-nums">{d.memory.length} notes</span>} />
            <Card className="divide-y divide-line-soft">
              {d.memory.map((m) => (
                <details key={m.id} className="group px-4 py-2.5 text-[13px]">
                  <summary className="flex cursor-pointer list-none items-baseline gap-2">
                    <span className="font-medium text-ink">{m.key}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-muted group-open:hidden">{m.notes}</span>
                    <span className="shrink-0 text-[11.5px] text-ink-faint"><Ago at={m.updated_at} now={now} /></span>
                  </summary>
                  <form action={memoryPutAction} className="mt-2 space-y-2">
                    <input type="hidden" name="scope" value={a.id} />
                    <input type="hidden" name="key" value={m.key} />
                    <textarea name="notes" defaultValue={m.notes} rows={4} className={inputCls} />
                    <p className="text-[11.5px] text-ink-faint">Source: {m.source ?? 'not given'} · last edit by {m.updated_by ?? 'unknown'}</p>
                    <div className="flex gap-2">
                      <button className={btnCls} type="submit">Save</button>
                    </div>
                  </form>
                  <form action={memoryDeleteAction} className="mt-2">
                    <input type="hidden" name="scope" value={a.id} />
                    <input type="hidden" name="key" value={m.key} />
                    <button className="text-[12px] text-bad hover:underline" type="submit">Delete this note</button>
                  </form>
                </details>
              ))}
              <form action={memoryPutAction} className="space-y-2 p-3">
                <input type="hidden" name="scope" value={a.id} />
                <p className="text-[12px] font-medium text-ink-muted">Add a note to {a.display_name}&apos;s memory</p>
                <input name="key" required maxLength={200} className={inputCls} placeholder="Short title, e.g. tone for jewelers" />
                <textarea name="notes" required rows={2} className={inputCls} placeholder="What they should remember" />
                <button className={btnCls} type="submit">Save note</button>
              </form>
            </Card>
          </section>
        </div>

        <aside className="space-y-5">
          <ConnectPanel db={db} actor={a} agents={actors.filter((x) => x.kind === 'agent')} now={now} />
          <section>
            <SectionHeader title={`Give ${a.display_name} a task`} />
            <Card className="p-3">
              <form action={createTaskAction} className="space-y-2.5">
                <input type="hidden" name="assigned_to" value={a.id} />
                <input type="hidden" name="return_to" value={`/agents/${a.id}`} />
                <input name="title" required maxLength={300} className={inputCls} placeholder={isAgent ? 'e.g. Find 200 jewelers in Ohio' : 'What should they do?'} />
                <textarea name="body" rows={3} className={inputCls} placeholder="Details, links, what done looks like" />
                <select name="project_id" className={inputCls} defaultValue="">
                  <option value="">No project</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button type="submit" className={`${primaryBtnCls} w-full`}>Assign to {a.display_name}</button>
              </form>
              {isAgent ? <p className="mt-2 text-[11.5px] leading-snug text-ink-faint">{a.display_name} is told right away on its channels above (the Inbox below shows sent / delivered / read). Nothing goes out to anyone without your OK.</p> : null}
            </Card>
          </section>
          <section>
            <SectionHeader title="Inbox" meta={d.notifications.some((n) => !n.read_at) && a.id === 'owner' ? <form action={markReadAction}><button className="text-accent" type="submit">Mark all read</button></form> : null} />
            <Card className="divide-y divide-line-soft">
              {d.notifications.length ? d.notifications.map((n) => (
                <div key={n.id} className={`px-3 py-2 text-[12px] leading-snug ${n.read_at ? 'text-ink-faint' : 'text-ink'}`}>
                  <p>
                    {n.task_id ? <Link className="hover:text-accent" href={`/team/${n.task_id}`}>{n.summary}</Link> : n.summary} <span className="text-ink-faint">· <Ago at={n.created_at} now={now} /></span>
                  </p>
                  {n.kind === 'message' && n.body && n.body.length > 160 ? <p className="mt-1 whitespace-pre-wrap text-ink-muted">{n.body.slice(0, 2000)}</p> : null}
                  <p className="mt-0.5"><DeliveryChip status={n.delivery as DeliveryStatus} error={n.delivery_error} human={!isAgent} /></p>
                </div>
              )) : <EmptyNote>Nothing for them.</EmptyNote>}
            </Card>
          </section>
          {d.locks.length ? (
            <section>
              <SectionHeader title="Checked out" />
              <Card className="divide-y divide-line-soft">
                {d.locks.map((l) => <p key={l.resource} className="px-3 py-2 text-[12px] text-ink-muted"><span className="text-ink">{l.resource}</span>{l.note ? ` · ${l.note}` : ''} · until <Ago at={l.lease_expires_at} now={now} /></p>)}
              </Card>
            </section>
          ) : null}
          <section>
            <SectionHeader title="Recent activity" />
            <Card className="divide-y divide-line-soft">
              {d.events.length ? d.events.map((e) => <p key={e.id} className="px-3 py-2 text-[12px] leading-snug text-ink-muted">{e.summary} <span className="text-ink-faint">· <Ago at={e.at} now={now} /></span></p>) : <EmptyNote>No activity yet.</EmptyNote>}
            </Card>
          </section>
          {isAgent ? (
            <section>
              <SectionHeader title="Shared team notes" meta={<span className="tabular-nums">{shared.length}</span>} />
              <Card className="divide-y divide-line-soft">
                {shared.length ? shared.slice(0, 8).map((m) => <p key={m.id} className="px-3 py-2 text-[12px]"><span className="font-medium text-ink">{m.key}</span> <span className="text-ink-muted">{m.notes.slice(0, 120)}</span></p>) : <EmptyNote>No shared notes yet.</EmptyNote>}
              </Card>
            </section>
          ) : null}
        </aside>
      </div>
    </PageFrame>
  )
}
