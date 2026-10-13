import Link from 'next/link'
import { getDb } from '@/lib/db'
import { loadReplyDesk, replyDeskCounts, groupReplies, REPLY_BUCKETS, BUCKET_LABELS, type ReplyBucket, type ReplyItem } from '@/lib/leads/replies'
import { PageShell, DbNotConnected } from '@/components/app/PageShell'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { dateTime, place } from '@/components/leads/pills'

export const dynamic = 'force-dynamic'

const BUCKET_NOTES: Record<ReplyBucket, string> = {
  needs_reply: 'A person wrote back and nothing has gone out since.',
  interested: 'Marked interested, meeting booked, or closed in Instantly.',
  not_now: 'Not interested, neutral, or wrong person.',
  auto: 'Out-of-office and other automatic replies. Not counted as replies.',
  unsubscribed: 'Asked to stop. Instantly won’t email them again.',
  bounced: 'The address bounced.',
  answered: 'Replied, and an email went out after.',
}

/** Collapsed by default: these rarely need anything. */
const QUIET: ReplyBucket[] = ['auto', 'unsubscribed', 'bounced', 'answered']

export default async function RepliesPage() {
  const db = getDb()
  if (!db) {
    return (
      <PageShell title="Replies">
        <DbNotConnected what="The reply desk" />
      </PageShell>
    )
  }
  const [items, counts] = await Promise.all([loadReplyDesk(db), replyDeskCounts(db)])
  const g = groupReplies(items)
  // Counts come from every lead; the list shows the newest 500, and says so when it is cut.
  const waiting = counts.needs_reply
  const capped = counts.total > items.length
  return (
    <PageShell
      title="Replies"
      meta={`${waiting} waiting on you · ${counts.total} lead${counts.total === 1 ? '' : 's'} with reply events${capped ? ` (newest ${items.length} listed)` : ''} · answer in Instantly’s Unibox`}
    >
      <nav aria-label="Reply groups" className="-mx-4 mb-5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
        <ul className="flex w-max gap-1.5">
          {REPLY_BUCKETS.map((b) => (
            <li key={b}>
              <a href={`#${b}`} className="block whitespace-nowrap rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink-muted hover:text-ink">
                {BUCKET_LABELS[b]} <span className="tabular-nums text-ink">{counts[b]}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {items.length === 0 ? (
        <Card>
          <EmptyNote>No replies yet. They land here as Instantly reports them.</EmptyNote>
        </Card>
      ) : (
        <div className="flex flex-col gap-7">
          {REPLY_BUCKETS.filter((b) => !QUIET.includes(b)).map((b) => (
            <Bucket key={b} bucket={b} items={g[b]} />
          ))}
          <div className="grid gap-7 lg:grid-cols-2">
            {QUIET.map((b) => (
              <Bucket key={b} bucket={b} items={g[b]} compact />
            ))}
          </div>
        </div>
      )}
    </PageShell>
  )
}

function Bucket({ bucket, items, compact = false }: { bucket: ReplyBucket; items: ReplyItem[]; compact?: boolean }) {
  return (
    <section id={bucket} aria-labelledby={`${bucket}-h`} className="scroll-mt-16">
      <SectionHeader id={`${bucket}-h`} title={`${BUCKET_LABELS[bucket]} · ${items.length}`} meta={BUCKET_NOTES[bucket]} />
      <Card>
        {items.length === 0 ? (
          <EmptyNote>None.</EmptyNote>
        ) : (
          <ul className="divide-y divide-line-soft">
            {(compact ? items.slice(0, 8) : items).map((r) => (
              <ReplyRow key={r.touch_id} r={r} compact={compact} />
            ))}
            {compact && items.length > 8 ? <li className="px-4 py-2 text-xs text-ink-faint">and {items.length - 8} more</li> : null}
          </ul>
        )}
      </Card>
    </section>
  )
}

function ReplyRow({ r, compact }: { r: ReplyItem; compact: boolean }) {
  const where = place(r.city, r.state)
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 truncate">
          {r.company_id ? (
            <Link href={`/leads/${r.company_id}`} prefetch={false} className="font-medium text-ink hover:text-accent">
              {r.company_name ?? r.email}
            </Link>
          ) : (
            <span className="font-medium text-ink">{r.email ?? 'Unknown lead'}</span>
          )}
          {where ? <span className="ml-2 text-xs text-ink-faint">{where}</span> : null}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-ink-faint">{dateTime(r.occurred_at)}</span>
      </div>
      <div className="truncate text-xs text-ink-faint">{[r.company_id ? r.email : null, r.campaign_name].filter(Boolean).join(' · ')}</div>
      {!compact && (r.subject || r.snippet) ? (
        <div className="mt-1.5 border-l-2 border-line pl-3">
          {r.subject ? <p className="truncate text-xs font-medium text-ink-muted">{r.subject}</p> : null}
          {r.snippet ? <p className="line-clamp-3 break-words text-sm text-ink">{r.snippet}</p> : null}
        </div>
      ) : null}
      {!compact && r.unibox_url ? (
        <a href={r.unibox_url} target="_blank" rel="noreferrer noopener" className="mt-1.5 inline-block text-xs font-medium text-accent">
          Open in Unibox ↗
        </a>
      ) : null}
    </li>
  )
}
