import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db'
import { DbNotConnected, BUTTON, BUTTON_PRIMARY } from '@/components/app/PageShell'
import { Card, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { inputCls } from '@/components/ops/bits'
import { CheckPill, Diff, Env, Flash, one, SetupCard, Steps, when } from '@/components/seo/bits'
import { ChangeNotice } from '@/components/seo/ChangeNotice'
import { listActors, type ActorView } from '@/lib/ops/queries'
import { getFixTask, getSite, type FixTask, type SiteRow } from '@/lib/seo/store'
import { listChanges, previewChange, type ApplyInput, type ChangeRow } from '@/lib/seo/changes'
import { WP_SNIPPET, wpConfigFromEnv, wpMatchesSite } from '@/lib/seo/wordpress'
import type { FixAction } from '@/lib/seo/fixes'
import { applyChangeAction, runAuditAction, undoChangeAction, updateFixAction } from '@/app/actions/seo'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

function Hidden({ fields }: { fields: Record<string, string | number | null | undefined> }) {
  return (
    <>
      {Object.entries(fields).map(([k, v]) => (v == null ? null : <input key={k} type="hidden" name={k} value={String(v)} />))}
    </>
  )
}

function Recheck({ site, back, label = 'Done, re-check' }: { site: SiteRow; back: string; label?: string }) {
  return (
    <form action={runAuditAction}>
      <Hidden fields={{ site_id: site.id, return_to: back }} />
      <button className={BUTTON_PRIMARY}>{label}</button>
    </form>
  )
}

function WpSetup() {
  return (
    <SetupCard title="Connect WordPress to apply this from here" testId="wp-setup">
      <Steps
        steps={[
          'In WordPress: Users > Profile > Application Passwords. Name it "TapDash dashboard" and press Add. Copy the password it shows (built into WordPress, free).',
          'In Vercel > this project > Settings > Environment Variables add WP_SITE_URL (https://tapdash.co), WP_USER (your WordPress username) and WP_APP_PASSWORD (the password you copied). Redeploy.',
          'Come back here: the Preview and Apply buttons appear. Every change shows a diff first and can be undone.',
        ]}
      />
    </SetupCard>
  )
}

function SnippetCard() {
  return (
    <SetupCard title="One-time: let the dashboard edit Yoast fields and schema" testId="wp-snippet">
      <p>
        Your pages are built with Elementor, which ignores page text sent through the API, and Yoast keeps its title, description and canonical in hidden fields. This
        short snippet exposes exactly those fields (and prints the page&rsquo;s schema in the head). Install the free <b>Code Snippets</b> plugin, then Snippets &gt; Add New,
        paste, choose &ldquo;Run everywhere&rdquo;, Save and Activate.
      </p>
      <textarea readOnly rows={12} defaultValue={WP_SNIPPET} className={`${inputCls} font-numeric text-[11px]`} />
    </SetupCard>
  )
}

async function Preview({ db, site, task, input, back }: { db: NonNullable<ReturnType<typeof getDb>>; site: SiteRow; task: FixTask; input: ApplyInput; back: string }) {
  let pv: Awaited<ReturnType<typeof previewChange>> | null = null
  let err: string | null = null
  try {
    pv = await previewChange(db, site.id, input)
  } catch (e) {
    err = (e as Error).message
  }
  if (err || !pv) return <p role="alert" className="rounded-card border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad">Preview failed: {err}</p>
  const needs = pv.needsSnippet && input.kind !== 'create_draft' && !(input.kind === 'hide_page' && input.mode === 'draft')
  const fields: Record<string, string | number | null> = { site_id: site.id, task_id: task.id, kind: input.kind, return_to: back }
  if (input.kind === 'set_meta') Object.assign(fields, { field: input.field, path: input.path, value: input.value })
  if (input.kind === 'add_schema') Object.assign(fields, { path: input.path, value: input.value })
  if (input.kind === 'hide_page') Object.assign(fields, { path: input.path, mode: input.mode })
  if (input.kind === 'create_draft') Object.assign(fields, { title: input.title, slug: input.slug, content: input.content })
  return (
    <div className="space-y-3" data-testid="seo-preview">
      <p className="text-[12px] text-ink-faint">Live from WordPress: {pv.target}</p>
      <Diff before={pv.before} after={pv.after} />
      {needs ? (
        <SnippetCard />
      ) : (
        <form action={applyChangeAction} className="flex items-center gap-2">
          <Hidden fields={fields} />
          {input.kind === 'set_meta' || input.kind === 'add_schema' ? <input type="hidden" name="expect_before" value={pv.before ?? ''} /> : null}
          <button className={BUTTON_PRIMARY}>{input.kind === 'create_draft' ? 'Create draft in WordPress' : 'Apply to WordPress'}</button>
          <span className="text-[12px] text-ink-faint">{input.kind === 'create_draft' ? 'Saved as a draft; nothing goes live.' : 'Logged to Activity; undo stays available.'}</span>
        </form>
      )}
    </div>
  )
}

export default async function SeoFix({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params
  const sp = await searchParams
  const db = getDb()
  if (!db) return <DbNotConnected what="The SEO section" />
  const task = await getFixTask(db, Number(id))
  if (!task) notFound()
  const site = await getSite(db, task.payload.site_id)
  if (!site) notFound()
  const [changes, actors] = await Promise.all([listChanges(db, { taskId: task.id }), listActors(db)])
  const fix = task.payload.fix
  const a: FixAction = fix.action
  const citation = task.payload.citation_evidence
  const evidenceUrl = citation ? `/seo/citations?site=${site.id}&run=${citation.run_id}#answer-${citation.result_id}` : null
  const back = `/seo/todos/${task.id}`
  const wpOn = wpMatchesSite(wpConfigFromEnv(), site.base_url)
  const previewing = one(sp.preview) === '1'
  const live = ['queued', 'claimed', 'running', 'blocked', 'needs_approval'].includes(task.status)

  let panel: React.ReactNode = null
  if (a.type === 'manual') {
    panel = (
      <div className="space-y-3">
        <Steps steps={a.steps} />
        {evidenceUrl ? <Link href="/seo/visibility" className={BUTTON}>Run a new visibility check</Link> : <Recheck site={site} back={back} />}
      </div>
    )
  } else if (a.type === 'copy_file') {
    panel = (
      <div className="space-y-3">
        <p className="text-[13px] text-ink">{a.where}</p>
        <label className="block text-[12px] text-ink-muted">
          {a.filename}
          <textarea readOnly rows={12} defaultValue={a.content} className={`${inputCls} mt-1 font-numeric text-[11px]`} />
        </label>
        <Recheck site={site} back={back} />
      </div>
    )
  } else if (!wpOn) {
    panel = (
      <div className="space-y-3">
        <WpSetup />
        {a.type === 'set_meta' || a.type === 'add_schema' ? (
          <label className="block text-[12px] text-ink-muted">
            Or paste it by hand ({a.type === 'set_meta' ? `Yoast > ${a.field}` : 'schema JSON-LD'}):
            <textarea readOnly rows={a.type === 'add_schema' ? 12 : 3} defaultValue={a.proposed} className={`${inputCls} mt-1 font-numeric text-[12px]`} />
          </label>
        ) : null}
        <Recheck site={site} back={back} label="I did it by hand, re-check" />
      </div>
    )
  } else if (a.type === 'set_meta' || a.type === 'add_schema') {
    const value = one(sp.value) ?? a.proposed
    const path = fix.page ?? '/'
    panel = (
      <div className="space-y-4">
        {a.type === 'set_meta' ? <p className="text-[13px] text-ink-muted">Now: {a.current ? `“${a.current}”` : 'not set'}</p> : null}
        <form method="get" className="space-y-2">
          <input type="hidden" name="preview" value="1" />
          <textarea name="value" rows={a.type === 'add_schema' ? 16 : 3} defaultValue={value} className={`${inputCls} font-numeric text-[12px]`} />
          <button className={BUTTON}>Preview change</button>
        </form>
        {previewing ? (
          <Preview
            db={db}
            site={site}
            task={task}
            back={back}
            input={a.type === 'set_meta' ? { kind: 'set_meta', field: a.field, path, value, expect_before: null } : { kind: 'add_schema', path, value, expect_before: null }}
          />
        ) : null}
      </div>
    )
  } else if (a.type === 'hide_pages') {
    const url = one(sp.url)
    const mode = one(sp.mode) === 'draft' ? 'draft' : 'noindex'
    panel = (
      <div className="space-y-4">
        <ul className="divide-y divide-line rounded-card border border-line">
          {a.urls.map((u) => {
            const p = new URL(u).pathname
            return (
              <li key={u} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <a href={u} target="_blank" rel="noreferrer" className="text-[13px] text-ink underline">{p}</a>
                <div className="flex gap-2">
                  <Link prefetch={false} className={BUTTON} href={`${back}?preview=1&url=${encodeURIComponent(p)}&mode=noindex`}>Hide from Google</Link>
                  <Link prefetch={false} className={BUTTON} href={`${back}?preview=1&url=${encodeURIComponent(p)}&mode=draft`}>Move to draft</Link>
                </div>
              </li>
            )
          })}
        </ul>
        <p className="text-[12px] text-ink-faint">&ldquo;Hide from Google&rdquo; keeps the page working (right for thank-you and form pages). &ldquo;Move to draft&rdquo; takes it off the site (right for test pages).</p>
        {previewing && url ? <Preview db={db} site={site} task={task} back={back} input={{ kind: 'hide_page', path: url, mode }} /> : null}
        <Recheck site={site} back={back} label="Re-check sitemap" />
      </div>
    )
  } else if (a.type === 'create_draft') {
    const title = one(sp.title) ?? a.title
    const slug = one(sp.slug) ?? a.slug
    const content = one(sp.content) ?? a.content
    panel = (
      <div className="space-y-4">
        <form method="get" className="space-y-2">
          <input type="hidden" name="preview" value="1" />
          <input name="title" defaultValue={title} className={inputCls} />
          <input name="slug" defaultValue={slug} className={`${inputCls} font-numeric text-[12px]`} />
          <textarea name="content" rows={12} defaultValue={content} className={`${inputCls} font-numeric text-[12px]`} />
          <button className={BUTTON}>Preview draft</button>
        </form>
        {previewing ? <Preview db={db} site={site} task={task} back={back} input={{ kind: 'create_draft', title, slug, content }} /> : null}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Flash sp={sp} />
      <div>
        <Link href="/seo/todos" className="text-[12px] text-accent underline">← Fix list</Link>
        <h2 className="mt-2 text-[16px] font-semibold tracking-[-0.01em] text-ink" data-testid="seo-fix-title">{fix.title}</h2>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-faint">
          <CheckPill status={fix.severity === 'fail' ? 'fail' : fix.severity === 'unknown' ? 'unknown' : 'warn'} />
          <span>{site.name}</span>
          {fix.page ? <span>· {fix.page}</span> : null}
          <span>·</span>
          <Pill tone={task.status === 'done' ? 'good' : 'neutral'}>{task.status}</Pill>
          {task.assigned_to ? <span>· assigned to {actors.find((x) => x.id === task.assigned_to)?.display_name ?? task.assigned_to}</span> : null}
          {task.claimed_by ? <span>· {actors.find((x) => x.id === task.claimed_by)?.display_name ?? task.claimed_by} is on it</span> : null}
          <Link href={`/team/${task.id}`} className="text-accent underline">task thread</Link>
        </p>
      </div>

      <Card className="px-4 py-4">
        <p className="text-[13px] leading-relaxed text-ink">{fix.detail}</p>
        {evidenceUrl && citation ? <p className="mt-2 text-[12px] text-ink-muted"><Link className="text-accent underline" href={evidenceUrl}>View stored answer #{citation.result_id} and citations</Link> · {citation.provider} · {citation.model}. Completing this task does not verify a visibility gain.</p> : null}
        {fix.fix ? <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">What fixes it: {fix.fix}</p> : null}
      </Card>

      <section>
        <SectionHeader title="Do it" />
        <Card className="px-4 py-4">{panel}</Card>
      </section>

      <section>
        <SectionHeader title="Who" />
        <Card className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <form action={updateFixAction} className="flex items-center gap-2">
            <Hidden fields={{ task_id: task.id, op: 'assign', return_to: back }} />
            <select name="assigned_to" defaultValue={task.assigned_to ?? 'tab'} className={`${inputCls} w-auto`}>
              {actors
                .filter((x: ActorView) => x.id !== 'system')
                .map((x) => (
                  <option key={x.id} value={x.id}>{x.id === 'owner' ? 'Me' : x.display_name}</option>
                ))}
            </select>
            <button className={BUTTON}>Assign</button>
          </form>
          <div className="flex gap-2">
            {live ? (
              <>
                <form action={updateFixAction}>
                  <Hidden fields={{ task_id: task.id, op: 'done', return_to: back }} />
                  <button className={BUTTON}>Mark done</button>
                </form>
                <form action={updateFixAction}>
                  <Hidden fields={{ task_id: task.id, op: 'dismiss', return_to: back }} />
                  <button className={BUTTON}>Dismiss</button>
                </form>
              </>
            ) : (
              <form action={updateFixAction}>
                <Hidden fields={{ task_id: task.id, op: 'reopen', return_to: back }} />
                <button className={BUTTON}>Reopen</button>
              </form>
            )}
          </div>
        </Card>
      </section>

      {changes.length ? (
        <section>
          <SectionHeader title="WordPress changes" />
          <Card>
            <ul className="divide-y divide-line">
              {changes.map((c: ChangeRow) => (
                <li key={c.id} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between" data-testid="seo-change">
                  <span className="text-[13px] text-ink">
                    #{c.id} {c.kind.replace('_', ' ')} · {c.target} <span className="text-ink-faint">· {c.applied_at ? when(c.applied_at) : 'Not confirmed applied'}</span>
                    <ChangeNotice status={c.status} />
                  </span>
                  {c.status === 'applied' ? (
                    <form action={undoChangeAction}>
                      <Hidden fields={{ change_id: c.id, return_to: back }} />
                      <button className={BUTTON}>Undo</button>
                    </form>
                  ) : (
                    <Pill tone="neutral">{c.status}{c.undone_at ? ` ${when(c.undone_at)}` : ''}</Pill>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}
      <p className="text-[12px] text-ink-faint">
        Agents pick these up as <Env name="seo_fix" /> tasks through the ops API (claim, report, complete) like any other board task.
      </p>
    </div>
  )
}
