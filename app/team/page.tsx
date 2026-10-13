import Link from 'next/link'
import { getDb } from '@/lib/db'
import { boardTasks, listActors, listProjects, type BoardTask } from '@/lib/ops/queries'
import { createTaskAction } from '@/app/actions/ops'
import { AutoRefresh } from '@/components/ops/AutoRefresh'
import { DbNotConnected, PageFrame, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { TaskCard } from '@/components/ops/TaskCard'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'

export const dynamic = 'force-dynamic'

const COLUMNS: { key: string; title: string; statuses: string[] }[] = [
  { key: 'todo', title: 'To do', statuses: ['queued'] },
  { key: 'doing', title: 'In progress', statuses: ['claimed', 'running'] },
  { key: 'waiting', title: 'Waiting', statuses: ['blocked', 'needs_approval'] },
  { key: 'done', title: 'Done this week', statuses: ['done', 'failed', 'cancelled'] },
]

type SP = Promise<{ project?: string; person?: string; kind?: string }>

export default async function TeamPage({ searchParams }: { searchParams: SP }) {
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Team board" meta="Humans and agents on the same tasks">
        <DbNotConnected />
      </PageFrame>
    )
  }
  const sp = await searchParams
  const projectId = Number(sp.project) > 0 ? Number(sp.project) : null
  const person = sp.person || null
  const [tasks, actors, projects] = await Promise.all([
    boardTasks(db, { project_id: projectId, person, kind: sp.kind || null }),
    listActors(db),
    listProjects(db),
  ])
  const now = new Date()
  const by = (statuses: string[]) => tasks.filter((t: BoardTask) => statuses.includes(t.status))
  const qs = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams()
    const merged = { project: sp.project ?? null, person: sp.person ?? null, kind: sp.kind ?? null, ...patch }
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v)
    const s = p.toString()
    return s ? `/team?${s}` : '/team'
  }
  const chip = (active: boolean) =>
    `rounded-full border px-2.5 py-1 text-xs ${active ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-ink-muted hover:text-ink'}`

  return (
    <PageFrame
      title="Team board"
      meta={`${tasks.filter((t) => !['done', 'failed', 'cancelled'].includes(t.status)).length} open tasks · humans and agents claim, comment, hand off and approve here`}
    >
      <AutoRefresh seconds={20} />
      <div className="mb-4 flex flex-wrap gap-1.5" aria-label="Filter by project">
        <Link className={chip(!projectId)} href={qs({ project: null })}>All projects</Link>
        {projects.map((p) => (
          <Link key={p.id} className={chip(projectId === p.id)} href={qs({ project: String(p.id) })}>
            {p.name} <span className="tabular-nums text-ink-faint">{p.open_tasks}</span>
          </Link>
        ))}
      </div>
      <div className="mb-5 flex flex-wrap gap-1.5" aria-label="Filter by person">
        <Link className={chip(!person)} href={qs({ person: null })}>Everyone</Link>
        {actors.map((a) => (
          <Link key={a.id} className={chip(person === a.id)} href={qs({ person: a.id })}>
            {a.display_name}
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((c) => {
            const list = by(c.statuses)
            return (
              <section key={c.key} aria-labelledby={`col-${c.key}`} className="min-w-0">
                <SectionHeader id={`col-${c.key}`} title={c.title} meta={<span className="tabular-nums">{list.length}</span>} />
                <div className="space-y-2">
                  {list.length ? list.map((t) => <TaskCard key={t.id} t={t} now={now} />) : <p className="rounded-card border border-dashed border-line px-3 py-6 text-center text-xs text-ink-faint">Nothing here</p>}
                </div>
              </section>
            )
          })}
        </div>

        <aside>
          <SectionHeader title="New task" />
          <Card className="p-3">
            <form action={createTaskAction} className="space-y-2.5">
              <label className="block text-xs text-ink-muted">
                What needs doing
                <input name="title" required maxLength={300} className={`${inputCls} mt-1`} placeholder="e.g. Research 50 Maryland jewelers" />
              </label>
              <label className="block text-xs text-ink-muted">
                Details (use @tab, @hermes to loop someone in)
                <textarea name="body" rows={3} className={`${inputCls} mt-1`} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs text-ink-muted">
                  Who
                  <select name="assigned_to" className={`${inputCls} mt-1`} defaultValue="tab">
                    <option value="">Anyone</option>
                    {actors.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.display_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs text-ink-muted">
                  Project
                  <select name="project_id" className={`${inputCls} mt-1`} defaultValue={projectId ?? ''}>
                    <option value="">None</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block text-xs text-ink-muted">
                Priority
                <select name="priority" className={`${inputCls} mt-1`} defaultValue="0">
                  <option value="0">Normal</option>
                  <option value="5">High</option>
                  <option value="9">Urgent</option>
                </select>
              </label>
              <button type="submit" className={`${primaryBtnCls} w-full`}>
                Add to the board
              </button>
            </form>
          </Card>
          <p className="mt-3 text-xs leading-relaxed text-ink-faint">
            Agents pick up tasks through the ops API the same way you do here. A task assigned to someone waits for them; an unassigned one goes to whoever claims it first.
          </p>
          {!tasks.length ? <EmptyNote>No tasks yet.</EmptyNote> : null}
        </aside>
      </div>
    </PageFrame>
  )
}
