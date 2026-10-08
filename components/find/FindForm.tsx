'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const STAGES = [
  { id: 'discover', label: 'Find businesses', hint: 'Map search by city, chain and pawn filter, dedupe against your leads' },
  { id: 'crawl', label: 'Read their websites', hint: 'Emails, owner lines, phone, Shopify/Square/Clover hints' },
  { id: 'owner', label: 'Owner search', hint: 'Web search for the owner and "@domain" emails (needs a search provider on the runner)' },
  { id: 'reviews', label: 'Maps reviews', hint: 'Owner names in Google reviews ("Ken, the owner"); best extra name source. Serper only', extra: true },
  { id: 'yelp', label: 'Yelp owner', hint: 'Yelp "Business Owner" replies, only when the listing is this store', extra: true },
  { id: 'firstlast', label: 'Owner last name', hint: 'Searches "<first name> + store + city" for the last name', extra: true },
  { id: 'facebook', label: 'Facebook page', hint: 'Email shown on the store\'s public Facebook page, for stores with none on their site', extra: true },
  { id: 'pattern', label: 'Email pattern', hint: 'Owner address in the store\'s own pattern (sarah@ -> ken@). Held as a guess until verified', extra: true },
  { id: 'build', label: 'Add to Leads', hint: 'Companies, contacts and evidence go into Leads' },
] as const satisfies readonly { id: string; label: string; hint: string; extra?: boolean }[]

/** "MD, VA" -> states; "Towson, MD; Columbia, MD" -> cities. */
export function parseWhere(where: string): { states: string[]; cities: string[] } {
  const states: string[] = []
  const cities: string[] = []
  for (const seg of where.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^,]{3,}),\s*([A-Za-z]{2})$/.exec(seg)
    if (m) cities.push(`${m[1].trim()}, ${m[2].toUpperCase()}`)
    else for (const tok of seg.split(',').map((s) => s.trim())) if (/^[A-Za-z]{2}$/.test(tok)) states.push(tok.toUpperCase())
  }
  return { states, cities }
}

export function FindForm({ jewelerQueries, agencyQueries }: { jewelerQueries: string[]; agencyQueries: string[] }) {
  const router = useRouter()
  const [segment, setSegment] = useState<'jeweler' | 'ai_agency'>('jeweler')
  const [where, setWhere] = useState('MD')
  const [allUs, setAllUs] = useState(false)
  const [max, setMax] = useState('100')
  const [queries, setQueries] = useState(jewelerQueries.join(', '))
  const [stages, setStages] = useState<string[]>(STAGES.filter((s) => !('extra' in s && s.extra)).map((s) => s.id))
  const [proxies, setProxies] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  function pickSegment(s: 'jeweler' | 'ai_agency') {
    setSegment(s)
    setQueries((s === 'jeweler' ? jewelerQueries : agencyQueries).join(', '))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    const { states, cities } = parseWhere(where)
    try {
      const r = await fetch('/api/find/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          segment,
          states: allUs ? [] : states,
          cities: allUs ? [] : cities,
          all_us: allUs,
          max_businesses: Number(max),
          queries: queries.split(',').map((q) => q.trim()).filter(Boolean),
          stages,
          proxies,
        }),
      })
      const j = await r.json()
      if (!r.ok) setMsg({ tone: 'bad', text: j.error ?? `Could not start (HTTP ${r.status})` })
      else {
        setMsg({ tone: 'good', text: `Job #${j.job.id} queued for Tab. It starts when Tab's runner picks it up.` })
        router.refresh()
      }
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const label = 'block text-[12px] font-medium text-ink-muted'
  const input = 'mt-1 w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[13.5px] text-ink outline-none focus:border-accent'

  return (
    <form onSubmit={submit} className="grid gap-4 p-4 sm:p-5">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Segment">
        {(
          [
            ['jeweler', 'Independent jewelers'],
            ['ai_agency', 'AI agencies / builders'],
          ] as const
        ).map(([id, text]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={segment === id}
            onClick={() => pickSegment(id)}
            className={`rounded-full border px-3 py-1 text-[12.5px] ${segment === id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-muted hover:border-ink-faint'}`}
          >
            {text}
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <label className={label}>
          Where
          <input className={input} value={where} onChange={(e) => setWhere(e.target.value)} disabled={allUs} placeholder="MD, VA  or  Towson, MD; Columbia, MD" />
          <span className="mt-1 block text-[11.5px] font-normal text-ink-faint">States (MD, VA) or cities (&quot;Towson, MD&quot;, separated by ;). Cities come from the top-1000 US cities list.</span>
        </label>
        <label className={label}>
          Max businesses
          <input className={`${input} tabular-nums`} inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-[12.5px] text-ink-muted">
        <input type="checkbox" checked={allUs} onChange={(e) => setAllUs(e.target.checked)} /> All of the US (top-1000 cities)
      </label>

      <label className={label}>
        Searches
        <input className={input} value={queries} onChange={(e) => setQueries(e.target.value)} />
        <span className="mt-1 block text-[11.5px] font-normal text-ink-faint">
          {segment === 'jeweler' ? 'The set that found the Oct 6 list (7 searches per city).' : 'A starting set; not measured yet.'}
        </span>
      </label>

      <fieldset>
        <legend className={label}>Steps</legend>
        <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
          {STAGES.map((s) => (
            <label key={s.id} className="flex items-start gap-2 rounded-md border border-line px-2.5 py-2 text-[12.5px]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={stages.includes(s.id)}
                disabled={s.id === 'discover'}
                onChange={(e) => setStages((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))}
              />
              <span>
                <span className="text-ink">{s.label}</span>
                {'extra' in s && s.extra ? <span className="ml-1.5 text-[11px] text-ink-faint">opt-in</span> : null}
                <span className="block text-[11.5px] text-ink-faint">{s.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-[12.5px] text-ink-muted">
        <input type="checkbox" checked={proxies} onChange={(e) => setProxies(e.target.checked)} /> Rotate proxies (uses the runner&apos;s ENGINE_PROXIES list)
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-surface disabled:opacity-50">
          {busy ? 'Starting…' : 'Find leads'}
        </button>
        {msg ? <p className={`text-[12.5px] ${msg.tone === 'good' ? 'text-good' : 'text-bad'}`}>{msg.text}</p> : null}
      </div>
    </form>
  )
}
