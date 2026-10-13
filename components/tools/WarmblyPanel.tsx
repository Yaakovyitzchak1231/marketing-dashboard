import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card, EmptyNote, Pill, SectionHeader, type PillTone } from '@/components/dashboard/primitives'
import type { WarmblyView } from '@/lib/warmbly/config'
import type { CampaignRow, MailboxRow, Part, WarmblySnapshot } from '@/lib/warmbly/snapshot'

/**
 * Warmbly on /tools (TAP-118): a live, read-only look at his self-hosted
 * Warmbly — mailboxes and their warm-up/health, campaigns, 14-day warm-up
 * totals. Every number is what Warmbly's API answered on this page load;
 * anything it did not send shows "—" ("Not reported by Warmbly"), never 0.
 */

const NOT_REPORTED = 'Not reported by Warmbly'

function Dash() {
  return (
    <span className="text-unavailable" title={NOT_REPORTED} aria-label={NOT_REPORTED}>
      —
    </span>
  )
}

function N({ v }: { v: number | null }) {
  return v === null ? <Dash /> : <span className="font-numeric tabular-nums">{v.toLocaleString('en-US')}</span>
}

function Word({ v }: { v: string | null }) {
  return v === null ? <Dash /> : <>{v.replace(/_/g, ' ')}</>
}

const AUTH_TONE: Record<string, PillTone> = { pass: 'good', valid: 'good', ok: 'good', fail: 'bad', invalid: 'bad', missing: 'bad', none: 'warn' }

function Auth({ label, v }: { label: string; v: string | null }) {
  if (v === null) return null
  return (
    <Pill tone={AUTH_TONE[v.toLowerCase()] ?? 'neutral'} title={`${label}: ${v}`}>
      {label} {v}
    </Pill>
  )
}

function warmupPill(w: MailboxRow['warmup']) {
  if (w === null) return <Dash />
  if (w === 'on') return <Pill tone="good">Warming</Pill>
  if (w === 'paused') return <Pill tone="warn">Paused</Pill>
  return <Pill tone="neutral">Off</Pill>
}

function PartError({ what, part }: { what: string; part: Extract<Part<unknown>, { ok: false }> }) {
  return (
    <p className="rounded-control border border-bad/30 bg-bad-soft px-3 py-2 text-xs text-bad">
      Couldn&apos;t read {what}: {part.error}
    </p>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-2xs uppercase tracking-[0.06em] text-ink-faint">{label}</div>
      <div className="mt-0.5 text-lg font-semibold text-ink">{children}</div>
    </div>
  )
}

function Mailboxes({ rows }: { rows: MailboxRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line text-left text-ink-faint">
            <th className="py-1.5 pr-3 font-medium">Mailbox</th>
            <th className="py-1.5 pr-3 font-medium">Status</th>
            <th className="py-1.5 pr-3 font-medium">Warm-up</th>
            <th className="py-1.5 pr-3 font-medium">Sending</th>
            <th className="py-1.5 font-medium">DNS</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((m) => (
            <tr key={m.id}>
              <td className="py-1.5 pr-3">
                <div className="truncate text-ink">{m.email ?? <Dash />}</div>
                {m.provider ? <div className="text-2xs text-ink-faint">{m.provider}</div> : null}
              </td>
              <td className="py-1.5 pr-3 text-ink-muted">
                <Word v={m.status} />
              </td>
              <td className="py-1.5 pr-3">{warmupPill(m.warmup)}</td>
              <td className="py-1.5 pr-3 text-ink-muted" title={m.sendingReason ?? undefined}>
                <Word v={m.sending} />
              </td>
              <td className="py-1.5">
                <div className="flex flex-wrap gap-1">
                  <Auth label="SPF" v={m.spf} />
                  <Auth label="DKIM" v={m.dkim} />
                  <Auth label="DMARC" v={m.dmarc} />
                  {m.spf === null && m.dkim === null && m.dmarc === null ? <Dash /> : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Campaigns({ rows }: { rows: CampaignRow[] }) {
  return (
    <ul className="divide-y divide-line text-xs">
      {rows.map((c) => (
        <li key={c.id} className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="min-w-0 truncate text-ink">
            {c.name ?? <Dash />}
            {c.guardrail ? <span className="ml-2 text-bad">· {c.guardrail}</span> : null}
          </span>
          <span className="shrink-0 text-ink-muted">
            <Word v={c.status} />
            {c.dailyLimit !== null ? <span className="text-ink-faint"> · {c.dailyLimit}/day</span> : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Snapshot({ snap }: { snap: WarmblySnapshot }) {
  const { mailboxes, campaigns, warmup, allowance } = snap
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Mailboxes">{mailboxes.ok ? <N v={mailboxes.value.total ?? mailboxes.value.rows.length} /> : <Dash />}</Stat>
        <Stat label="Campaigns">{campaigns.ok ? <N v={campaigns.value.total ?? campaigns.value.rows.length} /> : <Dash />}</Stat>
        <Stat label="Warm-up sent, 14 days">{warmup.ok ? <N v={warmup.value.sent} /> : <Dash />}</Stat>
        <Stat label="Warm-up replies, 14 days">{warmup.ok ? <N v={warmup.value.replied} /> : <Dash />}</Stat>
      </div>
      {allowance.ok && allowance.value.used !== null ? (
        <p className="text-xs text-ink-faint">
          Sent today: <N v={allowance.value.used} />
          {allowance.value.allowance !== null ? (
            <>
              {' '}
              of <N v={allowance.value.allowance} />
            </>
          ) : allowance.value.basis ? (
            <> · no daily cap ({allowance.value.basis})</>
          ) : null}
        </p>
      ) : null}

      <div>
        <h3 className="mb-1 text-sm font-semibold text-ink">Mailboxes</h3>
        {!mailboxes.ok ? (
          <PartError what="mailboxes" part={mailboxes} />
        ) : mailboxes.value.rows.length ? (
          <>
            <Mailboxes rows={mailboxes.value.rows} />
            {mailboxes.value.truncated ? <p className="mt-1 text-2xs text-ink-faint">Showing the first {mailboxes.value.rows.length}; open Warmbly for the rest.</p> : null}
          </>
        ) : (
          <EmptyNote>No mailboxes connected in Warmbly yet. Add them in Warmbly; they show up here with their warm-up and DNS status.</EmptyNote>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold text-ink">Campaigns</h3>
        {!campaigns.ok ? (
          <PartError what="campaigns" part={campaigns} />
        ) : campaigns.value.rows.length ? (
          <Campaigns rows={campaigns.value.rows} />
        ) : (
          <EmptyNote>No campaigns in Warmbly yet. Instantly is still the sender.</EmptyNote>
        )}
      </div>
      {!warmup.ok ? <PartError what="warm-up totals" part={warmup} /> : null}
    </div>
  )
}

export function WarmblyPanel({ view }: { view: WarmblyView }) {
  let body: ReactNode
  let meta: ReactNode = null
  if (view.state === 'no_url') {
    body = (
      <p className="text-xs text-ink-muted">
        No Warmbly address yet. Set <span className="font-medium">Warmbly URL</span> on <Link href="/settings" className="text-accent hover:underline">Settings</Link>.
      </p>
    )
  } else if (view.state === 'no_key') {
    body = (
      <p className="text-xs text-ink-muted">
        Not connected: add a read-only Warmbly API key as <span className="font-medium">Warmbly API key</span> on{' '}
        <Link href="/settings" className="text-accent hover:underline">Settings</Link> (or the WARMBLY_API_KEY env var).
      </p>
    )
  } else {
    const me = view.snapshot.me
    meta = me.ok ? (
      <span>
        Live from Warmbly{me.value.organization ? ` · ${me.value.organization}` : ''} · read-only key
      </span>
    ) : null
    body = me.ok ? <Snapshot snap={view.snapshot} /> : <PartError what="Warmbly" part={me} />
  }
  return (
    <section aria-labelledby="warmbly-panel">
      <SectionHeader id="warmbly-panel" title="Warmbly" meta={meta} />
      <Card className="p-4">{body}</Card>
    </section>
  )
}
