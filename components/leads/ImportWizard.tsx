'use client'

import { useState } from 'react'
import Link from 'next/link'
import { inputCls, btnCls, primaryBtnCls } from '@/components/ops/bits'
import type { ParsedCsv, ImportRequest } from '@/app/actions/leads-import'
import type { ImportSummary } from '@/lib/leads/csv-import'

type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string }

const TARGET_FIELDS = [
  { value: 'skip', label: '(ignore this column)' },
  { value: 'email', label: 'Email' },
  { value: 'first_name', label: 'First name' },
  { value: 'last_name', label: 'Last name' },
  { value: 'title', label: 'Title' },
  { value: 'phone', label: 'Phone' },
  { value: 'company_name', label: 'Company name' },
  { value: 'website', label: 'Website' },
  { value: 'company_phone', label: 'Company phone' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State' },
]

function guessTarget(header: string): string {
  const h = header.trim().toLowerCase().replace(/[\s_-]+/g, '_')
  const known = TARGET_FIELDS.map((t) => t.value)
  if (known.includes(h)) return h
  if (h === 'name' || h === 'full_name') return 'skip'
  if (h === 'company') return 'company_name'
  if (h === 'url' || h === 'domain') return 'website'
  return 'skip'
}

export function ImportWizard({
  parseCsv,
  preview,
  runImport,
  pools,
  campaigns,
  contactCustomFields,
  companyCustomFields,
}: {
  parseCsv: (csv: string) => Promise<ActionResult<ParsedCsv>>
  preview: (req: ImportRequest) => Promise<ActionResult<ImportSummary>>
  runImport: (req: ImportRequest) => Promise<ActionResult<ImportSummary>>
  pools: { id: string; label: string }[]
  campaigns: { id: number; name: string }[]
  contactCustomFields: { key: string; label: string }[]
  companyCustomFields: { key: string; label: string }[]
}) {
  const [step, setStep] = useState<'paste' | 'map' | 'preview' | 'done'>('paste')
  const [csvText, setCsvText] = useState('')
  const [parsed, setParsed] = useState<ParsedCsv | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [pool, setPool] = useState('')
  const [campaignId, setCampaignId] = useState('')
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const targets = [
    ...TARGET_FIELDS,
    ...contactCustomFields.map((f) => ({ value: `contact_custom.${f.key}`, label: `Contact field: ${f.label}` })),
    ...companyCustomFields.map((f) => ({ value: `company_custom.${f.key}`, label: `Company field: ${f.label}` })),
  ]

  async function onParse() {
    setError(null)
    setBusy(true)
    const r = await parseCsv(csvText)
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setParsed(r)
    setMapping(Object.fromEntries(r.headers.map((h) => [h, guessTarget(h)])))
    setStep('map')
  }

  async function onPreview() {
    setError(null)
    setBusy(true)
    const r = await preview({ csv: csvText, mapping, pool: pool || null, campaign_id: campaignId ? Number(campaignId) : null })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setSummary(r)
    setStep('preview')
  }

  async function onImport() {
    setError(null)
    setBusy(true)
    const r = await runImport({ csv: csvText, mapping, pool: pool || null, campaign_id: campaignId ? Number(campaignId) : null })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setSummary(r)
    setStep('done')
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-[12.5px] text-warn">{error}</p> : null}

      {step === 'paste' ? (
        <div className="flex flex-col gap-3">
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            rows={8}
            placeholder={'email,first_name,last_name,company,phone\\nsara@example.com,Sara,Lee,Acme Jewelers,5551234567'}
            className={`${inputCls} font-mono text-[12px]`}
          />
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-[12.5px]"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (file) setCsvText(await file.text())
            }}
          />
          <div>
            <button type="button" disabled={!csvText.trim() || busy} onClick={onParse} className={primaryBtnCls}>
              {busy ? 'Reading…' : 'Next: map columns'}
            </button>
          </div>
        </div>
      ) : null}

      {step === 'map' && parsed ? (
        <div className="flex flex-col gap-4">
          <p className="text-[12.5px] text-ink-muted">{parsed.rowCount.toLocaleString('en-US')} data rows found. Map each column, then choose a pool and/or campaign to add these leads to.</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {parsed.headers.map((h) => (
              <label key={h} className="flex items-center gap-2 text-[12.5px]">
                <span className="w-36 shrink-0 truncate font-medium text-ink" title={h}>
                  {h}
                </span>
                <select value={mapping[h] ?? 'skip'} onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))} className={inputCls}>
                  {targets.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <select value={pool} onChange={(e) => setPool(e.target.value)} className={inputCls} style={{ maxWidth: 220 }}>
              <option value="">No pool (don&apos;t set one)</option>
              {pools.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className={inputCls} style={{ maxWidth: 260 }}>
              <option value="">Don&apos;t add to a campaign</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setStep('paste')} className={btnCls}>
              Back
            </button>
            <button type="button" disabled={busy} onClick={onPreview} className={primaryBtnCls}>
              {busy ? 'Checking…' : 'Preview'}
            </button>
          </div>
        </div>
      ) : null}

      {step === 'preview' && summary ? (
        <div className="flex flex-col gap-4">
          <SummaryCounts summary={summary} />
          <RowSample summary={summary} />
          <div className="flex gap-2">
            <button type="button" onClick={() => setStep('map')} className={btnCls}>
              Back to mapping
            </button>
            <button type="button" disabled={busy || summary.would_create + summary.would_update === 0} onClick={onImport} className={primaryBtnCls}>
              {busy ? 'Importing…' : `Import ${(summary.would_create + summary.would_update).toLocaleString('en-US')} rows`}
            </button>
          </div>
        </div>
      ) : null}

      {step === 'done' && summary ? (
        <div className="flex flex-col gap-4">
          <p className="text-[13px] font-medium text-ink">Imported.</p>
          <SummaryCounts summary={summary} />
          <div>
            <Link href="/leads" className={primaryBtnCls}>
              Go to Leads
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SummaryCounts({ summary }: { summary: ImportSummary }) {
  const rows: [string, number][] = [
    ['New', summary.would_create],
    ['Updated', summary.would_update],
    ['Already in this file', summary.skipped_duplicate],
    ['Suppressed', summary.skipped_suppressed],
    ['Invalid', summary.invalid],
  ]
  return (
    <div className="flex flex-wrap gap-4 text-[12.5px]">
      {rows.map(([label, n]) => (
        <div key={label}>
          <span className="font-numeric font-semibold text-ink">{n.toLocaleString('en-US')}</span> <span className="text-ink-muted">{label}</span>
        </div>
      ))}
      <div className="text-ink-faint">of {summary.total.toLocaleString('en-US')} rows</div>
    </div>
  )
}

function RowSample({ summary }: { summary: ImportSummary }) {
  const problems = summary.rows.filter((r) => r.outcome === 'invalid' || r.outcome === 'skipped_duplicate' || r.outcome === 'skipped_suppressed').slice(0, 20)
  if (!problems.length) return null
  return (
    <div>
      <p className="mb-1 text-[12px] font-medium text-ink-muted">Rows not imported (up to 20 shown)</p>
      <ul className="max-h-60 overflow-auto text-[12px] text-ink-faint">
        {problems.map((r) => (
          <li key={r.row} className="border-b border-line-soft py-1 last:border-0">
            Row {r.row}: {r.email ?? r.phone ?? '(no email/phone)'} -- {r.reason ?? r.outcome}
          </li>
        ))}
      </ul>
    </div>
  )
}
