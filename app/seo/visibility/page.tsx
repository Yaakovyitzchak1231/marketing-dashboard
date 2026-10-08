import { getDb } from '@/lib/db'
import { DbNotConnected, BUTTON, BUTTON_PRIMARY } from '@/components/app/PageShell'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { inputCls } from '@/components/ops/bits'
import { Env, Flash, when } from '@/components/seo/bits'
import { latestRuns, listCompetitors, listPrompts, runResults, type PromptRow, type VisResult, type VisRun } from '@/lib/seo/store'
import { PROVIDERS, providerKey, providerModel, webSearchOn } from '@/lib/seo/visibility'
import { addCompetitorAction, addPromptAction, removeCompetitorAction, runVisibilityAction, togglePromptAction } from '@/app/actions/seo'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

const host = (u: string) => {
  try {
    return new URL(u).host.replace(/^www\./, '')
  } catch {
    return u
  }
}

export default async function SeoVisibility({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const db = getDb()
  if (!db) return <DbNotConnected what="The SEO section" />
  let prompts: PromptRow[] = []
  let runs: VisRun[] = []
  let results: VisResult[] = []
  let comps: { id: number; name: string; domain: string | null }[] = []
  try {
    ;[prompts, runs, comps] = await Promise.all([listPrompts(db), latestRuns(db), listCompetitors(db)])
    results = await runResults(db, runs.map((r) => r.id))
  } catch {
    return <EmptyNote>Couldn&rsquo;t read the SEO tables. Run the database migrations.</EmptyNote>
  }
  const runFor = (p: string) => runs.find((r) => r.provider === p)
  const shown = PROVIDERS.filter((p) => runFor(p.id))

  return (
    <div className="space-y-7">
      <Flash sp={sp} />
      <section>
        <SectionHeader title="Models" meta={webSearchOn() ? 'live web search on (SEO_WEB_SEARCH=1)' : 'answers from model knowledge; set SEO_WEB_SEARCH=1 for live search'} />
        <div className="grid gap-3 sm:grid-cols-2">
          {PROVIDERS.map((p) => {
            const on = !!providerKey(p)
            const r = runFor(p.id)
            return (
              <Card key={p.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3" data-testid={`seo-provider-${p.id}`}>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-ink">
                      {p.label} {on ? <Pill tone="good">ready</Pill> : <Pill tone="neutral">key not set</Pill>}
                    </p>
                    <p className="mt-0.5 text-[12px] text-ink-faint">{p.cost}</p>
                    {on ? (
                      <p className="mt-1 text-[12px] text-ink-muted">
                        Model {providerModel(p)}
                        {r ? ` · last run ${when(r.finished_at ?? r.started_at)}: ${r.status === 'done' ? `named in ${r.mentioned} of ${r.prompt_count}` : r.status}` : ' · not run yet'}
                      </p>
                    ) : (
                      <p className="mt-1 text-[12px] text-ink-muted">
                        To turn on: add <Env name={p.env} /> in Vercel and redeploy.
                      </p>
                    )}
                  </div>
                  <form action={runVisibilityAction} className="shrink-0">
                    <input type="hidden" name="provider" value={p.id} />
                    <input type="hidden" name="return_to" value="/seo/visibility" />
                    <button className={BUTTON_PRIMARY} disabled={!on || !prompts.some((x) => x.active)}>
                      Run check now
                    </button>
                  </form>
                </div>
              </Card>
            )
          })}
        </div>
      </section>

      <section>
        <SectionHeader title="Results" meta="latest run per model" />
        {shown.length === 0 ? (
          <EmptyNote>No runs yet. Set a model key above (Gemini&rsquo;s free tier costs nothing), then press &ldquo;Run check now&rdquo;.</EmptyNote>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[12px]">
              <thead className="text-left text-ink-faint">
                <tr>
                  <th className="px-4 py-2 font-medium">Question</th>
                  {shown.map((p) => (
                    <th key={p.id} className="px-3 py-2 font-medium">{p.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line align-top">
                {[...new Set(results.map((r) => r.prompt))].map((q) => (
                  <tr key={q}>
                    <td className="px-4 py-2 text-ink">{q}</td>
                    {shown.map((p) => {
                      const r = results.find((x) => x.prompt === q && x.run_id === runFor(p.id)!.id)
                      if (!r) return <td key={p.id} className="px-3 py-2 text-ink-faint">not asked</td>
                      if (r.error) return <td key={p.id} className="px-3 py-2 text-bad">error: {r.error.slice(0, 80)}</td>
                      return (
                        <td key={p.id} className="px-3 py-2" data-testid="seo-vis-cell">
                          {r.mentioned ? <Pill tone="good">TapDash named</Pill> : <Pill tone="bad">not named</Pill>}
                          {r.competitors.length ? <p className="mt-1 text-ink-muted">Named: {r.competitors.join(', ')}</p> : null}
                          {r.cited_urls.length ? <p className="mt-0.5 text-ink-faint">Cited: {[...new Set(r.cited_urls.map(host))].slice(0, 4).join(', ')}</p> : null}
                          {r.answer ? (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-accent">answer</summary>
                              <p className="mt-1 whitespace-pre-wrap text-ink-muted">{r.answer.slice(0, 3000)}</p>
                            </details>
                          ) : null}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <section>
        <SectionHeader title="Questions" meta={`${prompts.filter((p) => p.active).length} active`} />
        <Card>
          <ul className="divide-y divide-line">
            {prompts.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2" data-testid="seo-prompt">
                <span className={`text-[13px] ${p.active ? 'text-ink' : 'text-ink-faint line-through'}`}>
                  {p.prompt} {p.campaign ? <span className="text-ink-faint">· {p.campaign}</span> : null}
                </span>
                <form action={togglePromptAction}>
                  <input type="hidden" name="prompt_id" value={p.id} />
                  <input type="hidden" name="active" value={p.active ? '0' : '1'} />
                  <input type="hidden" name="return_to" value="/seo/visibility" />
                  <button className={BUTTON}>{p.active ? 'Turn off' : 'Turn on'}</button>
                </form>
              </li>
            ))}
          </ul>
          <form action={addPromptAction} className="flex flex-col gap-2 border-t border-line px-4 py-3 sm:flex-row">
            <input type="hidden" name="return_to" value="/seo/visibility" />
            <input name="prompt" required placeholder="What would a buyer ask? e.g. best card processor for a jewelry store in New Jersey" className={inputCls} />
            <input name="campaign" placeholder="campaign" className={`${inputCls} sm:max-w-[140px]`} />
            <button className={BUTTON_PRIMARY}>Add question</button>
          </form>
        </Card>
      </section>

      <section>
        <SectionHeader title="Competitors to watch for" />
        <Card className="px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {comps.map((c) => (
              <form key={c.id} action={removeCompetitorAction} className="inline-flex">
                <input type="hidden" name="competitor_id" value={c.id} />
                <input type="hidden" name="return_to" value="/seo/visibility" />
                <button className="rounded-card border border-line bg-canvas px-2 py-0.5 text-[12px] text-ink-muted hover:text-bad" title={`Remove ${c.name}`}>
                  {c.name} ×
                </button>
              </form>
            ))}
          </div>
          <form action={addCompetitorAction} className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input type="hidden" name="return_to" value="/seo/visibility" />
            <input name="name" required placeholder="Name" className={inputCls} />
            <input name="domain" placeholder="domain.com" className={inputCls} />
            <button className={BUTTON}>Add</button>
          </form>
        </Card>
      </section>
    </div>
  )
}
