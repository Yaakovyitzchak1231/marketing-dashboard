'use client'

/**
 * The Steps tab of a campaign: email steps (add, edit, reorder, delete), the
 * personalization fields they can use, a per-lead preview, and the Instantly link.
 * Talks to /api/campaign-steps/:id (lib/campaign-steps/http.ts) as the signed-in person.
 * Copy checks are warnings only; nothing here sends anything to Instantly.
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { BUTTON, BUTTON_PRIMARY } from '@/components/app/PageShell'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import type { PersonalizationField, CampaignRef } from '@/lib/campaign-steps/adapter'
import type { CopyWarning } from '@/lib/campaign-steps/render'
import type { StepRow } from '@/lib/campaign-steps/store'
import type { PushRequest } from '@/lib/campaign-steps/instantly'
import { LeadPreviewPanel } from './LeadPreview'
import { call } from './api'

export type StepView = StepRow & { warnings: CopyWarning[] }

export interface StepsEditorProps {
  campaign: CampaignRef
  steps: StepView[]
  fields: PersonalizationField[]
  fieldsFrom: string
  pushRequests: PushRequest[]
  leads: { company_id: number; company_name: string; email: string | null }[]
}

const input = 'w-full rounded-card border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint'

function Warnings({ list }: { list: CopyWarning[] }) {
  if (!list.length) return <Pill tone="good">Copy checks pass</Pill>
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Copy warnings">
      {list.map((w) => (
        <li key={w.code + w.message}>
          <Pill tone={w.code === 'leftover' ? 'bad' : 'warn'} title="A warning, not a blocker">
            {w.message}
          </Pill>
        </li>
      ))}
    </ul>
  )
}

function StepForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<StepRow>
  submitLabel: string
  onSubmit: (v: { subject: string; body: string; delay_days: number; variant: string }) => Promise<string | null>
  onCancel?: () => void
}) {
  const [subject, setSubject] = useState(initial?.subject ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [delay, setDelay] = useState(String(initial?.delay_days ?? 3))
  const [variant, setVariant] = useState(initial?.variant ?? 'A')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError(await onSubmit({ subject, body, delay_days: Number(delay), variant }))
        setBusy(false)
      }}
    >
      <label className="block text-[12px] text-ink-muted">
        Subject
        <input className={input} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Quick question, {{firstName}}" />
      </label>
      <label className="block text-[12px] text-ink-muted">
        Body
        <textarea className={`${input} min-h-[140px] font-[inherit]`} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Hi {{firstName}}, ..." />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="text-[12px] text-ink-muted">
          Wait (days)
          <input className={`${input} w-20`} type="number" min={0} max={365} value={delay} onChange={(e) => setDelay(e.target.value)} />
        </label>
        <label className="text-[12px] text-ink-muted">
          Variant
          <input className={`${input} w-20`} value={variant} onChange={(e) => setVariant(e.target.value)} />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" className={BUTTON_PRIMARY} disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className={BUTTON} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        {error ? (
          <span role="alert" className="text-[12px] text-bad">
            {error}
          </span>
        ) : null}
      </div>
    </form>
  )
}

export function StepsEditor({ campaign, steps, fields, fieldsFrom, pushRequests, leads }: StepsEditorProps) {
  const router = useRouter()
  const [editing, setEditing] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = campaign.id
  const refresh = () => router.refresh?.()
  const numbers = [...new Set(steps.map((s) => s.step_number))]

  async function act(path: string, method: string, body?: unknown) {
    setError(null)
    const r = await call(id, path, method, body)
    if (!r.ok) setError(r.error ?? 'That didn’t work.')
    else refresh()
    return r
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="steps-h">
        <SectionHeader id="steps-h" title="Email steps" meta={`${steps.length} step${steps.length === 1 ? '' : 's'} · checks are warnings, not blockers: no links, 55–80 words, end with a question`} />
        {error ? (
          <p role="alert" className="mb-2 text-[12px] text-bad">
            {error}
          </p>
        ) : null}
        {!steps.length ? <EmptyNote>No steps yet. Add the first email below.</EmptyNote> : null}
        <ol className="space-y-3">
          {steps.map((s) => {
            const idx = numbers.indexOf(s.step_number)
            return (
              <li key={s.id}>
                <Card className="p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
                    <span className="font-semibold text-ink">Step {s.step_number}</span>
                    <Pill tone="neutral">Variant {s.variant}</Pill>
                    <span>{s.step_number === 1 ? 'Sends first' : `Waits ${s.delay_days} day${s.delay_days === 1 ? '' : 's'}`}</span>
                    <span className="ml-auto flex gap-1">
                      <button type="button" className={BUTTON} aria-label={`Move step ${s.step_number} up`} disabled={idx <= 0} onClick={() => act('/reorder', 'POST', { order: swap(numbers, idx, idx - 1) })}>
                        ↑
                      </button>
                      <button type="button" className={BUTTON} aria-label={`Move step ${s.step_number} down`} disabled={idx >= numbers.length - 1} onClick={() => act('/reorder', 'POST', { order: swap(numbers, idx, idx + 1) })}>
                        ↓
                      </button>
                      <button type="button" className={BUTTON} onClick={() => setEditing(editing === s.id ? null : s.id)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className={BUTTON}
                        onClick={() => {
                          if (window.confirm(`Delete step ${s.step_number} (variant ${s.variant})? The activity log keeps a copy.`)) void act(`/${s.id}`, 'DELETE')
                        }}
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                  {editing === s.id ? (
                    <StepForm
                      initial={s}
                      submitLabel="Save step"
                      onCancel={() => setEditing(null)}
                      onSubmit={async (v) => {
                        const r = await call(id, `/${s.id}`, 'PATCH', v)
                        if (!r.ok) return r.error ?? 'That didn’t work.'
                        setEditing(null)
                        refresh()
                        return null
                      }}
                    />
                  ) : (
                    <>
                      <p className="text-[13px] font-medium text-ink">{s.subject || <span className="text-ink-faint">(no subject)</span>}</p>
                      <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-muted">{s.body}</p>
                      <div className="mt-2">
                        <Warnings list={s.warnings} />
                      </div>
                    </>
                  )}
                </Card>
              </li>
            )
          })}
        </ol>
        <div className="mt-3">
          {adding ? (
            <Card className="p-3">
              <StepForm
                submitLabel="Add step"
                onCancel={() => setAdding(false)}
                onSubmit={async (v) => {
                  const r = await call(id, '', 'POST', v)
                  if (!r.ok) return r.error ?? 'That didn’t work.'
                  setAdding(false)
                  refresh()
                  return null
                }}
              />
            </Card>
          ) : (
            <button type="button" className={BUTTON_PRIMARY} onClick={() => setAdding(true)}>
              Add step
            </button>
          )}
        </div>
      </section>

      <section aria-labelledby="fields-h">
        <SectionHeader id="fields-h" title="Personalization fields" meta={`From ${fieldsFrom}. Each fills from: campaign override → lead → enrichment fact → fallback.`} />
        <ul className="flex flex-wrap gap-1.5">
          {fields.map((f) => (
            <li key={f.id}>
              <Pill tone={f.required ? 'accent' : 'neutral'} title={`${f.source}${f.fallback ? ` · fallback "${f.fallback}"` : ' · no fallback'}${f.required ? ' · required for Ready-personalized' : ''}`}>
                {`{{${f.name}}}`}
              </Pill>
            </li>
          ))}
        </ul>
      </section>

      <LeadPreviewPanel campaignId={id} leads={leads} />

      <InstantlyLink campaign={campaign} requests={pushRequests} hasSteps={steps.length > 0} onChanged={refresh} />
    </div>
  )
}

function swap(list: number[], i: number, j: number): number[] {
  const out = [...list]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

function InstantlyLink({ campaign, requests, hasSteps, onChanged }: { campaign: CampaignRef; requests: PushRequest[]; hasSteps: boolean; onChanged: () => void }) {
  const [value, setValue] = useState(campaign.instantly_campaign_id ?? '')
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => setValue(campaign.instantly_campaign_id ?? ''), [campaign.instantly_campaign_id])
  const pending = requests.filter((r) => r.status === 'pending')

  async function run(path: string, method: string, body: unknown, ok: string) {
    setBusy(true)
    const r = await call(campaign.id, path, method, body)
    setBusy(false)
    setMsg(r.ok ? { tone: 'good', text: ok } : { tone: 'bad', text: r.error ?? 'That didn’t work.' })
    if (r.ok) onChanged()
  }

  return (
    <section aria-labelledby="instantly-h">
      <SectionHeader id="instantly-h" title="Instantly (optional)" meta="Linking stores the campaign id only. Pushing steps or leads waits for your OK; nothing is sent from this page." />
      <Card className="space-y-3 p-3">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void run('/instantly', 'PUT', { instantly_campaign_id: value.trim() || null }, value.trim() ? 'Linked. Nothing was sent.' : 'Unlinked.')
          }}
        >
          <label className="min-w-[260px] flex-1 text-[12px] text-ink-muted">
            Instantly campaign id or link
            <input className={input} value={value} onChange={(e) => setValue(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
          </label>
          <button type="submit" className={BUTTON} disabled={busy}>
            {campaign.instantly_campaign_id ? 'Save link' : 'Link'}
          </button>
        </form>
        {campaign.instantly_campaign_id ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BUTTON_PRIMARY}
              disabled={busy || !hasSteps || pending.length > 0}
              onClick={() => run('/instantly/push', 'POST', { what: 'steps_and_leads' }, 'Request created. The leads wait for an OK; nothing was sent.')}
            >
              Ask to push steps + Ready leads
            </button>
            <span className="text-[12px] text-ink-faint">Only Ready leads ever upload, and only after a person approves.</span>
          </div>
        ) : null}
        {msg ? (
          <p role={msg.tone === 'bad' ? 'alert' : 'status'} className={`text-[12px] ${msg.tone === 'bad' ? 'text-bad' : 'text-good'}`}>
            {msg.text}
          </p>
        ) : null}
        {requests.length ? (
          <ul className="space-y-1 text-[12px] text-ink-muted" aria-label="Push requests">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <Pill tone={r.status === 'pending' ? 'warn' : r.status === 'approved' ? 'good' : 'neutral'}>{r.status === 'pending' ? 'Waiting for OK' : r.status}</Pill>
                <span>
                  #{r.id} · {r.what.replace(/_/g, ' ')} · asked by {r.requested_by}
                </span>
                {r.status === 'pending' && r.approval_id != null ? (
                  <a className="underline" href="/activity#approvals">
                    Leads in Needs your OK
                  </a>
                ) : r.status === 'pending' && r.payload?.confirm_url ? (
                  <a className="underline" href={r.payload.confirm_url}>
                    Review and confirm the leads
                  </a>
                ) : null}
                {r.status === 'pending' && r.what !== 'leads' ? <span className="text-ink-faint">Steps: copy into Instantly by hand (not sent from here).</span> : null}
                {r.status === 'pending' ? (
                  <button type="button" className={BUTTON} disabled={busy} onClick={() => run(`/instantly/requests/${r.id}/cancel`, 'POST', {}, 'Withdrawn.')}>
                    Withdraw
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </section>
  )
}
