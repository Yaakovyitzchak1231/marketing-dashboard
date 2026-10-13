import Link from 'next/link'
import { getDb } from '@/lib/db'
import { DbNotConnected, BUTTON, BUTTON_PRIMARY } from '@/components/app/PageShell'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { Flash, one, when } from '@/components/seo/bits'
import { inputCls } from '@/components/ops/bits'
import { listSites } from '@/lib/seo/store'
import { citationObservation, citationSummary, loadCitationReport, snapshotFor } from '@/lib/seo/citations'
import { queueCitationAction } from '@/app/actions/seo'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>
const positiveId = (s: string | undefined) => s && /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) && Number(s) > 0 ? Number(s) : undefined

export default async function SeoCitations({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const db = getDb()
  if (!db) return <DbNotConnected what="Citation tracking" />
  let sites: Awaited<ReturnType<typeof listSites>>
  let report: Awaited<ReturnType<typeof loadCitationReport>> | null
  try {
    sites = await listSites(db)
    const rawSite = one(sp.site), rawRun = one(sp.run)
    if ((rawSite && !positiveId(rawSite)) || (rawRun && !positiveId(rawRun))) return <EmptyNote>Choose a valid site and run.</EmptyNote>
    const siteId = positiveId(rawSite) ?? sites[0]?.id
    report = siteId ? await loadCitationReport(db, siteId, positiveId(rawRun)) : null
  } catch {
    return <EmptyNote>Could not load citation evidence. Check the selected run, database connection and migrations. No measurements are shown.</EmptyNote>
  }
  if (!report) return <EmptyNote>Add a site before tracking citations.</EmptyNote>
  const { site, selected, previous, results, runs } = report
  const summary = selected ? citationSummary(selected, results, site.id) : null
  const before = previous ? citationSummary(previous, results, site.id) : null
  const snapshot = selected ? snapshotFor(selected, site.id) : null
  const rows = selected ? results.filter((r) => r.run_id === selected.id) : []
  const canQueue = site.active && snapshot?.base_url === site.base_url && selected?.status === 'done'
  return (
    <div className="space-y-7">
      <Flash sp={sp} />
      <section className="space-y-3">
        <SectionHeader title="Citations & actions" meta="Stored evidence, not a visibility score" />
        <p className="max-w-3xl text-sm text-ink-muted">See when your brand is named and when your pages are actually cited. These are sampled API answers, not consumer-app rankings, verified backlinks or a promise of traffic. A retrieved search result is not a citation.</p>
        <form method="get" className="flex items-end gap-2">
          <label className="text-xs text-ink-muted">Site
            <select name="site" defaultValue={site.id} className={`${inputCls} mt-1`}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? '' : ' (paused)'}</option>)}
            </select>
          </label>
          <button className={BUTTON}>View site</button>
        </form>
      </section>
      {!selected ? <EmptyNote>No citation-separated runs for this site yet. <Link href="/seo/visibility" className="text-accent underline">Run an AI visibility check</Link> when ready. Older mixed source lists remain in AI visibility; they cannot be reconstructed as confirmed citations.</EmptyNote> : (
        <>
          <section className="space-y-3">
            <SectionHeader title={`Run #${selected.id}`} meta={`${selected.provider} · ${selected.model} · ${when(selected.finished_at ?? selected.started_at)}`} />
            <p className="text-xs text-ink-muted">{selected.web_search === true ? 'Search-enabled request; tool use can vary by answer.' : selected.web_search === false ? 'Search was not enabled for this request.' : 'Historical search setting unavailable.'} Site and brand terms are the snapshot saved with this run.</p>
            {snapshot ? <p className="text-xs text-ink-faint">Recorded site: {snapshot.base_url} · Text matched against: {snapshot.brand_terms.join(', ')}</p> : null}
            {summary ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Card className="px-4 py-3"><p className="text-xs text-ink-muted">Brand named in text</p><p className="font-numeric text-xl">{summary.mentioned == null ? 'Unavailable' : `${summary.mentioned} of ${summary.answered} answers`}</p></Card>
                <Card className="px-4 py-3"><p className="text-xs text-ink-muted">Answers citing this site</p><p className="font-numeric text-xl">{summary.cited == null ? 'Unavailable' : `${summary.cited} of ${summary.answered} answers`}</p></Card>
              </div>
            ) : <EmptyNote>{selected.status === 'running' ? 'Run in progress. Final measurements are not available yet.' : 'Comparable citation measurements are unavailable for this run.'}</EmptyNote>}
            {summary ? <p className="text-xs text-ink-faint">{summary.failed} provider errors · {summary.unknown} unanswered or unmeasured. Neither counts as a negative.</p> : null}
            {before && previous ? <p className="text-xs text-ink-muted">Previous comparable run <Link className="text-accent underline" href={`/seo/citations?site=${site.id}&run=${previous.id}`}>#{previous.id}</Link>: {before.cited == null ? 'citation count unavailable' : `${before.cited} of ${before.answered} answers cited this site`}; {before.failed} errors, {before.unknown} unanswered. Same model, questions, brand terms and search setting; changes do not establish cause.</p> : <p className="text-xs text-ink-faint">No previous comparable run in the recent history window. Changed questions, models or search settings are not treated as a trend.</p>}
          </section>
          <section className="space-y-3">
            <SectionHeader title="Cited pages" meta="Exact URLs returned in citation metadata" />
            {summary?.sources.length ? <Card className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="text-ink-faint"><th className="px-4 py-2">URL</th><th className="px-4 py-2">Answers citing it</th></tr></thead><tbody className="divide-y divide-line">{summary.sources.map((s) => <tr key={s.url}><td className="break-all px-4 py-2"><a href={s.url} target="_blank" rel="noopener noreferrer" className="text-accent underline">{s.url}</a> {s.owned ? <Pill tone="neutral">this site</Pill> : null}</td><td className="px-4 py-2 font-numeric">{s.answers}</td></tr>)}</tbody></table></Card> : <EmptyNote>{summary?.answered ? 'No citation URLs were returned in the readable answers.' : 'No measurable citation evidence to list.'}</EmptyNote>}
          </section>
          <section className="space-y-3">
            <SectionHeader title="Evidence → action" meta="Queue a review or prepare a draft; nothing is published" />
            {rows.map((r) => {
              const obs = snapshot ? citationObservation(r, snapshot) : null
              return <Card key={r.id} className="scroll-mt-4 px-4 py-3" ><article id={`answer-${r.id}`}>
                <h3 className="text-sm font-medium text-ink">{r.prompt}</h3>
                <p className="mt-1 text-xs text-ink-faint">Answer #{r.id}{obs ? ` · ${obs.mentioned ? 'brand named' : 'brand not named'} · ${obs.owned.length} site citation URLs` : r.error !== null ? ` · provider error: ${r.error}` : ' · unanswered or unmeasured'}</p>
                {obs ? <>
                  <details className="mt-2 text-xs"><summary className="cursor-pointer text-accent">Answer and source evidence</summary><p className="mt-2 whitespace-pre-wrap text-ink-muted">{r.answer}</p>
                    <h4 className="mt-3 font-medium">Actual citations returned</h4>{obs.citations.length ? <ul>{obs.citations.map((u) => <li key={u} className="break-all"><a href={u} target="_blank" rel="noopener noreferrer" className="text-accent underline">{u}</a></li>)}</ul> : <p>No citation URLs returned.</p>}
                    <h4 className="mt-3 font-medium">Retrieved sources — not counted as citations</h4>{obs.retrieved.length ? <ul>{obs.retrieved.map((u) => <li key={u} className="break-all"><a href={u} target="_blank" rel="noopener noreferrer" className="text-accent underline">{u}</a></li>)}</ul> : <p>No retrieved-source URLs reported.</p>}
                  </details>
                  <p className="mt-2 text-xs text-ink-muted">Review existing pages before creating more content. This sample does not prove a missing page or explain why a source was selected.</p>
                  {canQueue ? <form action={queueCitationAction} className="mt-3 flex flex-wrap gap-2">
                    <input type="hidden" name="site_id" value={site.id} /><input type="hidden" name="result_id" value={r.id} />
                    <button name="mode" value="review" className={BUTTON_PRIMARY}>Queue content review</button>
                    {site.platform?.toLowerCase() === 'wordpress' ? <button name="mode" value="draft" className={BUTTON}>Prepare WordPress draft task</button> : null}
                  </form> : <p className="mt-2 text-xs text-ink-faint">Task creation is unavailable for this paused, changed or unfinished site/run.</p>}
                </> : null}
              </article></Card>
            })}
          </section>
        </>
      )}
      {runs.length ? <section><SectionHeader title="Run history" meta="Up to 40 recent runs; no checks start on page load" /><ul className="mt-2 space-y-2 text-xs">{runs.map((r) => <li key={r.id}><Link className="text-accent underline" href={`/seo/citations?site=${site.id}&run=${r.id}`}>Run #{r.id} · {r.provider} · {r.model} · {when(r.started_at)}</Link> · {r.status}</li>)}</ul></section> : null}
    </div>
  )
}
