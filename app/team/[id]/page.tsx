import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db'
import { getTaskDetail, listActors } from '@/lib/ops/queries'
import { claimMyselfAction, commentAction, handoffAction, updateTaskAction } from '@/app/actions/ops'
import { AutoRefresh } from '@/components/ops/AutoRefresh'
import { ActorLink, Ago, DbNotConnected, PageFrame, TaskStatus, btnCls, inputCls, kindLabel, primaryBtnCls } from '@/components/ops/bits'
import { Card, SectionHeader } from '@/components/dashboard/primitives'
import { DeliveryChip } from '@/components/ops/DeliveryChip'
import { taskDeliveryStates } from '@/lib/notify/deliver'

export const dynamic = 'force-dynamic'

function Mentioned({ body }: { body: string }) {
  const parts = body.split(/(@[a-z0-9][a-z0-9_.-]*)/gi)
  return (
    <>
      {parts.map((p, i) => (p.startsWith('@') ? <span key={i} className="font-medium text-accent">{p}</span> : <span key={i}>{p}</span>))}
    </>
  )
}

const COMMENT_LABEL: Record<string, string> = { comment: '', handoff: 'handed off', report: 'reported', system: '' }

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Task">
        <DbNotConnected />
      </PageFrame>
    )
  }
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) notFound()
  const [d, actors, told] = await Promise.all([getTaskDetail(db, id), listActors(db), taskDeliveryStates(db, id).catch(() => [])])
  if (!d) notFound()
  const { task: t, comments, events, approvals } = d
  const now = new Date()
  const live = ['queued', 'claimed', 'running', 'blocked', 'needs_approval'].includes(t.status)

  return (
    <PageFrame
      title={t.title}
      meta={
        <>
          <Link href="/team" className="hover:text-ink">Team board</Link> · {kindLabel(t.kind)}
          {t.project_name ? ` · ${t.project_name}` : ''} · opened <Ago at={t.created_at} now={now} />
        </>
      }
      actions={<TaskStatus status={t.status} />}
    >
      <AutoRefresh seconds={15} />
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-5">
          <Card className="divide-y divide-line-soft text-[13px]">
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
              <div>
                <p className="text-[11.5px] text-ink-faint">Assigned to</p>
                <p className="mt-0.5"><ActorLink id={t.assigned_to} name={t.assigned_name} /></p>
              </div>
              <div>
                <p className="text-[11.5px] text-ink-faint">Working on it</p>
                <p className="mt-0.5">{t.claimed_by ? <ActorLink id={t.claimed_by} name={t.claimed_name} /> : <span className="text-ink-faint">nobody yet</span>}</p>
              </div>
              <div>
                <p className="text-[11.5px] text-ink-faint">Last check-in</p>
                <p className="mt-0.5"><Ago at={t.heartbeat_at} now={now} /></p>
              </div>
              <div>
                <p className="text-[11.5px] text-ink-faint">Lease</p>
                <p className="mt-0.5">{t.lease_expires_at ? <>ends <Ago at={t.lease_expires_at} now={now} /></> : <span className="text-ink-faint">none</span>}</p>
              </div>
            </div>
            {t.company_id ? (
              <p className="px-4 py-2.5">
                Lead: <Link className="text-accent" href={`/leads/${t.company_id}`}>{t.company_name}</Link>
              </p>
            ) : null}
            {t.handoff_note ? <p className="px-4 py-2.5"><span className="text-ink-faint">Handoff note: </span>{t.handoff_note}</p> : null}
            {t.error ? <p className="px-4 py-2.5 text-bad">Problem: {t.error}</p> : null}
            {t.report ? <div className="whitespace-pre-wrap px-4 py-3 leading-relaxed"><p className="mb-1 text-[11.5px] text-ink-faint">Report</p>{t.report}</div> : null}
            {t.payload && Object.keys(t.payload as object).length ? (
              <details className="px-4 py-2.5">
                <summary className="cursor-pointer text-[12px] text-ink-muted">Job details</summary>
                <pre className="mt-2 overflow-x-auto rounded bg-canvas p-2 text-[11.5px] text-ink-muted">{JSON.stringify(t.payload, null, 2)}</pre>
              </details>
            ) : null}
          </Card>

          {approvals.length ? (
            <section>
              <SectionHeader title="Approvals" />
              <Card className="divide-y divide-line-soft text-[13px]">
                {approvals.map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span>{a.summary}</span>
                    <span className="text-ink-faint">{a.status}</span>
                  </div>
                ))}
              </Card>
              <p className="mt-1 text-[12px] text-ink-faint">Decide pending requests on the <Link className="text-accent" href="/activity">Activity</Link> screen.</p>
            </section>
          ) : null}

          <section aria-labelledby="thread">
            <SectionHeader id="thread" title="Thread" meta={`${comments.length}`} />
            <Card className="divide-y divide-line-soft">
              {comments.length ? (
                comments.map((c) => (
                  <div key={c.id} className="px-4 py-3 text-[13px]">
                    <p className="text-[12px] text-ink-faint">
                      <ActorLink id={c.author} name={c.author_name} /> {COMMENT_LABEL[c.kind] ?? ''} · <Ago at={c.created_at} now={now} />
                    </p>
                    <p className="mt-1 whitespace-pre-wrap leading-relaxed text-ink">
                      <Mentioned body={c.body} />
                    </p>
                  </div>
                ))
              ) : (
                <p className="px-4 py-5 text-[13px] text-ink-faint">No notes yet.</p>
              )}
              <form action={commentAction} className="space-y-2 p-3">
                <input type="hidden" name="task_id" value={t.id} />
                <textarea name="body" required rows={2} className={inputCls} placeholder="Add a note. @tab or @hermes notifies them." />
                <button type="submit" className={btnCls}>Post</button>
              </form>
            </Card>
          </section>
        </div>

        <aside className="space-y-5">
          {live ? (
            <section>
              <SectionHeader title="Actions" />
              <Card className="space-y-3 p-3">
                {!t.claimed_by ? (
                  <form action={claimMyselfAction}>
                    <input type="hidden" name="task_id" value={t.id} />
                    <button className={`${primaryBtnCls} w-full`} type="submit">I&apos;ll take it</button>
                  </form>
                ) : null}
                <form action={handoffAction} className="space-y-2">
                  <input type="hidden" name="task_id" value={t.id} />
                  <p className="text-[12px] font-medium text-ink-muted">Hand off</p>
                  <select name="to" className={inputCls} defaultValue="tab">
                    {actors.map((a) => (
                      <option key={a.id} value={a.id}>{a.display_name}</option>
                    ))}
                  </select>
                  <textarea name="note" required rows={2} className={inputCls} placeholder="Where it stands and what's next" />
                  <button className={`${btnCls} w-full`} type="submit">Hand off</button>
                </form>
                <div className="flex flex-wrap gap-2">
                  {t.status !== 'blocked' ? (
                    <form action={updateTaskAction}><input type="hidden" name="task_id" value={t.id} /><input type="hidden" name="status" value="blocked" /><button className={btnCls} type="submit">Mark blocked</button></form>
                  ) : (
                    <form action={updateTaskAction}><input type="hidden" name="task_id" value={t.id} /><input type="hidden" name="status" value="queued" /><button className={btnCls} type="submit">Unblock</button></form>
                  )}
                  <form action={updateTaskAction}><input type="hidden" name="task_id" value={t.id} /><input type="hidden" name="status" value="done" /><button className={btnCls} type="submit">Mark done</button></form>
                  <form action={updateTaskAction}><input type="hidden" name="task_id" value={t.id} /><input type="hidden" name="status" value="cancelled" /><button className={`${btnCls} text-bad`} type="submit">Cancel</button></form>
                </div>
              </Card>
            </section>
          ) : null}
          {told.length ? (
            <section>
              <SectionHeader title="Who was told" />
              <Card className="divide-y divide-line-soft">
                {told.map((n) => (
                  <div key={n.notification_id} className="px-3 py-2 text-[12px] leading-snug">
                    <p className="flex items-baseline gap-2">
                      <span className="font-medium text-ink">{n.recipient_name}</span>
                      <span className="ml-auto"><DeliveryChip status={n.status} error={n.last_error} human={n.recipient_kind === 'human'} /></span>
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-ink-muted">{n.summary} <span className="text-ink-faint">· <Ago at={n.created_at} now={now} /></span></p>
                  </div>
                ))}
              </Card>
            </section>
          ) : null}
          <section>
            <SectionHeader title="History" />
            <Card className="divide-y divide-line-soft">
              {events.map((e) => (
                <p key={e.id} className="px-3 py-2 text-[12px] leading-snug text-ink-muted">
                  {e.summary} <span className="text-ink-faint">· <Ago at={e.at} now={now} /></span>
                </p>
              ))}
            </Card>
          </section>
        </aside>
      </div>
    </PageFrame>
  )
}
