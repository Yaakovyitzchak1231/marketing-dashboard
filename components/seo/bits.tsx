import type { ReactNode } from 'react'
import { Card, Pill } from '@/components/dashboard/primitives'
import type { CheckStatus } from '@/lib/seo/audit'
import { lineDiff, prettyMaybeJson } from '@/lib/seo/diff'

export const CHECK_LABEL: Record<CheckStatus, string> = { pass: 'Pass', warn: 'Improve', fail: 'Fix', unknown: "Couldn't check", info: 'Info', blocked: 'Blocked' }
export function CheckPill({ status, reason }: { status: CheckStatus; reason?: string }) {
  const tone = status === 'pass' ? 'good' : status === 'fail' ? 'bad' : status === 'warn' ? 'warn' : status === 'blocked' ? 'accent' : 'neutral'
  return (
    <Pill tone={tone} title={reason}>
      {CHECK_LABEL[status]}
    </Pill>
  )
}

type SP = Record<string, string | string[] | undefined>
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? undefined

/** The plain message a button sends back (?ok= / ?err=). */
export function Flash({ sp }: { sp: SP }) {
  const ok = one(sp.ok)
  const err = one(sp.err)
  if (!ok && !err) return null
  return (
    <div
      role={err ? 'alert' : 'status'}
      className={`mb-4 rounded-card border px-3 py-2 text-sm ${err ? 'border-bad/30 bg-bad-soft text-bad' : 'border-good/30 bg-good-soft text-good'}`}
    >
      {err ?? ok}
    </div>
  )
}

export function SetupCard({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <Card className="px-4 py-4 sm:px-5">
      <div data-testid={testId}>
        <p className="text-2xs font-semibold uppercase tracking-[0.06em] text-warn">Setup needed</p>
        <h3 className="mt-1 text-base font-semibold text-ink">{title}</h3>
        <div className="mt-2 space-y-2 text-sm leading-relaxed text-ink-muted">{children}</div>
      </div>
    </Card>
  )
}

export function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-ink">
      {steps.filter(Boolean).map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ol>
  )
}

export function Env({ name }: { name: string }) {
  return <code className="rounded bg-canvas px-1 font-numeric text-xs text-ink">{name}</code>
}

export function Diff({ before, after }: { before: string | null; after: string | null }) {
  const lines = lineDiff(prettyMaybeJson(before), prettyMaybeJson(after))
  return (
    <pre data-testid="seo-diff" className="max-h-[420px] overflow-auto rounded-card border border-line bg-canvas p-2 font-numeric text-xs leading-[1.5]">
      {lines.map((l, i) => (
        <div key={i} className={l.op === 'add' ? 'bg-good-soft text-good' : l.op === 'del' ? 'bg-bad-soft text-bad line-through decoration-bad/40' : 'text-ink-muted'}>
          <span aria-hidden className="mr-2 select-none">{l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' '}</span>
          {l.text || ' '}
        </div>
      ))}
    </pre>
  )
}

export function when(d: string | Date | null): string {
  if (!d) return '—'
  const t = new Date(d)
  return t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
}
