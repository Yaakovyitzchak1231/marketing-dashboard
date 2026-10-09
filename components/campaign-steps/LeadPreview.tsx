'use client'

/** Pick a lead, see every step filled for them, with missing fields and copy warnings. */
import { useState } from 'react'
import { BUTTON } from '@/components/app/PageShell'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import type { LeadPreview } from '@/lib/campaign-steps/preview'
import { call } from './api'

const OUTLOOK: Record<LeadPreview['outlook'], { tone: 'good' | 'warn' | 'bad'; text: string }> = {
  ready_personalized: { tone: 'good', text: 'Copy: Ready-personalized' },
  ready_generic: { tone: 'warn', text: 'Copy: Ready-generic' },
  parked: { tone: 'bad', text: 'Copy: would be Parked' },
}
const SOURCE: Record<string, string> = { override: 'campaign override', lead: 'lead', enrichment: 'enrichment fact', fallback: 'fallback' }
const TIER: Record<string, string> = { ready_personalized: 'Ready-personalized', ready_generic: 'Ready-generic', parked: 'Parked' }

export function LeadPreviewPanel({ campaignId, leads }: { campaignId: number; leads: { company_id: number; company_name: string; email: string | null }[] }) {
  const [lead, setLead] = useState<string>('')
  const [p, setP] = useState<LeadPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load(id: string) {
    setLead(id)
    setP(null)
    setError(null)
    if (!id) return
    setBusy(true)
    const r = await call(campaignId, `/preview?lead=${encodeURIComponent(id)}`, 'GET')
    setBusy(false)
    if (!r.ok) setError(r.error ?? 'Couldn’t load the preview.')
    else setP(r.preview as LeadPreview)
  }

  return (
    <section aria-labelledby="preview-h">
      <SectionHeader id="preview-h" title="Preview for a lead" meta="Each step filled exactly as this lead would get it." />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="text-[12px] text-ink-muted">
          Lead
          <select
            className="block min-w-[260px] rounded-card border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink"
            value={lead}
            onChange={(e) => void load(e.target.value)}
          >
            <option value="">{leads.length ? 'Pick a lead…' : 'No leads in this campaign yet'}</option>
            {leads.map((l) => (
              <option key={l.company_id} value={String(l.company_id)}>
                {l.company_name}
                {l.email ? ` · ${l.email}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] text-ink-muted">
          or lead id
          <input
            className="block w-28 rounded-card border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink"
            inputMode="numeric"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void load((e.target as HTMLInputElement).value.trim())
              }
            }}
          />
        </label>
        {lead ? (
          <button type="button" className={BUTTON} onClick={() => void load(lead)} disabled={busy}>
            Refresh
          </button>
        ) : null}
      </div>
      {busy ? <p className="text-[12px] text-ink-faint">Loading…</p> : null}
      {error ? (
        <p role="alert" className="text-[12px] text-bad">
          {error}
        </p>
      ) : null}
      {p ? (
        <div className="space-y-3" data-testid="lead-preview">
          <Card className="space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="font-semibold text-ink">{p.lead.company_name}</span>
              <span className="text-ink-faint">{p.lead.email ?? 'no email'}</span>
              <Pill tone={OUTLOOK[p.outlook].tone}>{OUTLOOK[p.outlook].text}</Pill>
              {p.verdict ? (
                <Pill tone={p.verdict.tier === 'parked' ? 'bad' : 'neutral'} title={p.verdict.reasons.map((r) => r.label).join('; ')}>
                  Rules: {TIER[p.verdict.tier] ?? p.verdict.tier}
                  {p.verdict.stale ? ' (re-scoring)' : ''}
                </Pill>
              ) : null}
            </div>
            {p.outlook_why.length ? (
              <ul className="list-disc pl-5 text-[12px] text-ink-muted">
                {p.outlook_why.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
            <table className="w-full text-left text-[12px]">
              <thead className="text-ink-faint">
                <tr>
                  <th className="py-1 pr-3 font-medium">Field</th>
                  <th className="py-1 pr-3 font-medium">Value</th>
                  <th className="py-1 font-medium">From</th>
                </tr>
              </thead>
              <tbody>
                {p.fields.map((f) => (
                  <tr key={f.name} className="border-t border-line">
                    <td className="py-1 pr-3 font-numeric">{`{{${f.name}}}`}{f.required ? ' *' : ''}</td>
                    <td className="py-1 pr-3 text-ink">{f.value ?? <span className="text-bad">missing</span>}</td>
                    <td className="py-1 text-ink-muted">{f.from ? SOURCE[f.from] : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {!p.steps.length ? <EmptyNote>No steps to preview yet.</EmptyNote> : null}
          {p.steps.map((s) => (
            <Card key={s.step.id} className="p-3">
              <p className="text-[12px] text-ink-faint">
                Step {s.step.step_number} · variant {s.step.variant}
              </p>
              <p className="mt-1 text-[13px] font-medium text-ink">{s.subject.text || '(no subject)'}</p>
              <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-muted">{s.body.text}</p>
              {s.warnings.length ? (
                <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Warnings">
                  {s.warnings.map((w) => (
                    <li key={w.code + w.message}>
                      <Pill tone={w.code === 'leftover' ? 'bad' : 'warn'}>{w.message}</Pill>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-2">
                  <Pill tone="good">Copy checks pass</Pill>
                </div>
              )}
            </Card>
          ))}
        </div>
      ) : null}
    </section>
  )
}
