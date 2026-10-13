import type { ReactNode } from 'react'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { dateTime } from '@/components/leads/pills'
import { currentActorId, currentRole } from '@/lib/auth/session'
import { leadMailbox } from '@/lib/mailbox/server'
import type { LeadMailboxState } from '@/lib/mailbox/types'

/**
 * "Emails with you" on the lead's Timeline tab (TAP-114): the 1:1 emails
 * between the connected Outlook and this lead's addresses, read live and
 * read-only. Owner only. Renders nothing while the mailbox flag is off.
 */
export async function MailboxEmails({ addresses, companyId }: { addresses: string[]; companyId: number }) {
  // The connected inbox is the Owner's private mail: only the Owner sees it,
  // and only the Owner's own page views can save a rotated token. Editors and
  // viewers get nothing, and nothing is read from Outlook for them.
  if ((await currentRole().catch(() => null)) !== 'owner') return null
  const actor = await currentActorId().catch(() => null)
  const state = await leadMailbox(addresses, actor)
  if (state.state === 'off') return null
  const next = `/leads/${companyId}?tab=timeline`
  return <MailboxEmailsView state={state} isOwner next={next} />
}

/** Pure view, rendered directly in tests. */
export function MailboxEmailsView({ state, isOwner, next }: { state: Exclude<LeadMailboxState, { state: 'off' }>; isOwner: boolean; next: string }) {
  const connectHref = `/api/mailbox/outlook/connect?next=${encodeURIComponent(next)}`
  const connect = isOwner ? (
    <a href={connectHref} className="font-medium text-ink underline decoration-line underline-offset-2 hover:decoration-ink">
      Connect Outlook
    </a>
  ) : (
    <span>Ask the owner to connect Outlook.</span>
  )

  let meta: string | undefined
  let body: ReactNode
  if (state.state === 'not_configured') {
    body = <EmptyNote>Outlook isn’t set up yet. Add the {state.missing.join(' and ')} in Settings → Mailboxes.</EmptyNote>
  } else if (state.state === 'not_connected') {
    body = (
      <EmptyNote>
        No inbox connected. {connect} (read-only) to see your 1:1 emails with this lead here.
      </EmptyNote>
    )
  } else if (state.state === 'no_addresses') {
    body = <EmptyNote>This lead has no email address to match against your inbox.</EmptyNote>
  } else {
    const ok = state.results.filter((r) => r.status === 'ok')
    const errors = state.results.filter((r) => r.status === 'error')
    const inboxes = state.results.map((r) => r.address).join(', ')
    meta = ok.length ? `${state.messages.length}${state.truncated ? ' (latest)' : ''} · ${inboxes}` : inboxes
    body = (
      <>
        {errors.map((r) => (
          <p key={r.provider} className="px-4 py-2.5 text-xs text-ink-muted [overflow-wrap:anywhere]">
            Couldn’t read {r.label} ({r.address}): {r.status === 'error' ? r.error : ''}
            {isOwner ? (
              <>
                {' '}
                <a href={connectHref} className="underline underline-offset-2">
                  Reconnect
                </a>
              </>
            ) : null}
          </p>
        ))}
        {ok.length && state.messages.length ? (
          <ol className="divide-y divide-line-soft">
            {state.messages.map((m) => (
              <li key={`${m.provider}:${m.id}`} className="px-4 py-2.5 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <Pill tone={m.direction === 'sent' ? 'neutral' : 'accent'}>{m.direction === 'sent' ? 'You wrote' : 'They wrote'}</Pill>
                    <span className="min-w-0 font-medium text-ink [overflow-wrap:anywhere]">{m.subject || '(no subject)'}</span>
                  </span>
                  <span className="text-xs tabular-nums text-ink-faint">{dateTime(new Date(m.at))}</span>
                </div>
                <div className="text-xs text-ink-faint [overflow-wrap:anywhere]">
                  {m.direction === 'sent' ? `to ${m.matched}` : `from ${m.matched}`}
                  {m.webLink ? (
                    <>
                      {' · '}
                      <a href={m.webLink} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink">
                        Open in Outlook
                      </a>
                    </>
                  ) : null}
                </div>
                {m.preview ? <p className="mt-1 line-clamp-2 text-xs text-ink-muted [overflow-wrap:anywhere]">{m.preview}</p> : null}
              </li>
            ))}
          </ol>
        ) : ok.length ? (
          <EmptyNote>No 1:1 emails with {state.addresses.join(', ')} in {ok.map((r) => r.address).join(', ')}.</EmptyNote>
        ) : null}
      </>
    )
  }

  return (
    <section className="min-w-0">
      <SectionHeader title="Emails with you" meta={meta} />
      <Card className="overflow-hidden">{body}</Card>
    </section>
  )
}
