import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { getDb } from '@/lib/db'
import { getLeadDetail, type LeadDetail } from '@/lib/leads/detail'
import { PageShell, DbNotConnected } from '@/components/app/PageShell'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { StagePill, VerificationPill, ResearchPill, place, dateTime, shortDate } from '@/components/leads/pills'
import { StageSelect } from '@/components/leads/StageSelect'
import { CommentForm } from '@/components/leads/CommentForm'
import { EditFields } from '@/components/leads/EditFields'
import { EDITABLE_CONTACT_STATUSES, FIELD_LABELS } from '@/lib/leads/edit-fields'
import { SEGMENT_LABELS, STAGE_LABELS } from '@/lib/leads/filters'
import type { Stage, VerificationStatus } from '@/lib/leads/types'
import { leadReadiness, type LeadReadiness } from '@/lib/rules/readiness'
import { TierPill } from '@/components/rules/bits'
import { OwnerResearchToggle } from '@/components/rules/OwnerResearchToggle'

export const dynamic = 'force-dynamic'

const PROVIDER_LABEL: Record<string, string> = {
  precheck: 'Free check',
  millionverifier: 'MillionVerifier',
  zerobounce: 'ZeroBounce',
  sheet_import: 'Sheet (imported)',
  manual: 'Manual',
}

const EVENT_LABEL: Record<string, string> = {
  email_sent: 'Email sent',
  email_opened: 'Opened',
  email_link_clicked: 'Clicked a link',
  reply_received: 'Replied',
  auto_reply_received: 'Auto-reply',
  email_bounced: 'Bounced',
  lead_unsubscribed: 'Unsubscribed',
  lead_interested: 'Marked interested',
  lead_not_interested: 'Marked not interested',
  lead_neutral: 'Marked neutral',
  lead_meeting_booked: 'Meeting booked',
  lead_meeting_completed: 'Meeting completed',
  lead_closed: 'Closed',
  lead_out_of_office: 'Out of office',
  lead_wrong_person: 'Wrong person',
}

function safeHref(u: string | null): string | null {
  if (!u) return null
  try {
    const x = new URL(u)
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : null
  } catch {
    return null
  }
}

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = getDb()
  if (!db) {
    return (
      <PageShell title="Lead">
        <DbNotConnected what="This lead" />
      </PageShell>
    )
  }
  if (!/^\d{1,15}$/.test(id)) notFound()
  const [d, readiness] = await Promise.all([getLeadDetail(db, Number(id)), leadReadiness(db, Number(id))])
  if (!d) notFound()
  const c = d.company
  const site = safeHref(c.website)
  return (
    <PageShell
      title={c.name}
      meta={[place(c.city, c.state), SEGMENT_LABELS[c.segment] ?? c.segment, `added ${shortDate(c.created_at)}`].filter(Boolean).join(' · ')}
      actions={
        <>
          <Link href="/leads" prefetch={false} className="text-[12px] text-ink-faint hover:text-ink">
            ← All leads
          </Link>
          <StageSelect companyId={c.id} stage={c.stage} name={c.name} />
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card className="px-4 py-3">
            <div className="mb-2 flex justify-end">
              <EditFields
                endpoint={`/api/leads/${c.id}`}
                title="store details"
                fields={[
                  { name: 'name', label: 'Name', value: c.name },
                  { name: 'website', label: 'Website', value: c.website, type: 'url' },
                  { name: 'phone', label: 'Phone', value: c.phone, type: 'tel' },
                  { name: 'city', label: 'City', value: c.city },
                  { name: 'state', label: 'State', value: c.state },
                ]}
              />
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
              <Fact label="Stage"><StagePill stage={c.stage} /></Fact>
              <Fact label="Research"><ResearchPill status={c.research_status} />{c.last_researched_at ? <span className="ml-2 text-[12px] text-ink-faint">{shortDate(c.last_researched_at)}</span> : null}</Fact>
              <Fact label="Owner">{c.owner_name}</Fact>
              <Fact label="Website">{site ? <a href={site} target="_blank" rel="noreferrer noopener" className="text-accent">{c.website_domain ?? c.website}</a> : c.website}</Fact>
              <Fact label="Phone">{c.phone_e164 ?? c.phone}</Fact>
              <Fact label="Address">{[c.address_line, place(c.city, c.state), c.postal_code].filter(Boolean).join(', ') || null}</Fact>
              {c.vertical ? <Fact label="Type">{c.vertical}</Fact> : null}
              {c.notes ? <Fact label="Notes">{c.notes}</Fact> : null}
            </dl>
          </Card>

          <Readiness list={readiness} contacts={d.contacts} />
          <Card className="px-4 py-3">
            <OwnerResearchToggle
              companyId={c.id}
              exhausted={Boolean(c.owner_research_exhausted_at)}
              at={c.owner_research_exhausted_at ? shortDate(c.owner_research_exhausted_at) : null}
              by={c.owner_research_exhausted_by ? (d.actors.find((a) => a.id === c.owner_research_exhausted_by)?.display_name ?? c.owner_research_exhausted_by) : null}
            />
          </Card>

          <Section title="Contacts" meta={`${d.contacts.length}`}>
            {d.contacts.length ? (
              <ul className="divide-y divide-line-soft">
                {d.contacts.map((ct) => (
                  <li key={ct.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink">{ct.email ?? 'No email'}</div>
                      <div className="text-[12px] text-ink-faint">
                        {[[ct.first_name, ct.last_name].filter(Boolean).join(' ') || (ct.suggested_first_name ? `maybe ${ct.suggested_first_name}` : null), ct.title, ct.phone, ct.is_role_address ? 'shared inbox' : null, ct.email_source ? `found via ${ct.email_source}` : null, ct.status]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    <span className="flex items-center gap-1.5">
                      {ct.do_not_contact ? <Pill tone="bad">Do not contact</Pill> : null}
                      <VerificationPill status={ct.verification_status} />
                      <EditFields
                        endpoint={`/api/leads/${c.id}/contacts/${ct.id}`}
                        title={`contact ${ct.email ?? ct.id}`}
                        confirmEmailChange
                        fields={[
                          { name: 'first_name', label: 'First name', value: ct.first_name },
                          { name: 'last_name', label: 'Last name', value: ct.last_name },
                          { name: 'email', label: 'Email', value: ct.email, type: 'email' },
                          { name: 'title', label: 'Title / role', value: ct.title },
                          { name: 'phone', label: 'Phone', value: ct.phone, type: 'tel' },
                          { name: 'status', label: 'Status', value: ct.status, type: 'select', options: EDITABLE_CONTACT_STATUSES },
                        ]}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyNote>No email addresses yet. Research this lead to look for some.</EmptyNote>
            )}
          </Section>

          <Section title="Research findings" meta={`${d.enrichment.length}`}>
            {d.enrichment.length ? (
              <Table head={['Field', 'Value', 'Confidence', 'How', 'Last checked', 'Evidence']}>
                {d.enrichment.map((e) => (
                  <tr key={e.id}>
                    <Td className="whitespace-nowrap text-ink-muted">{e.field.replace(/_/g, ' ')}</Td>
                    <Td className="max-w-[240px] text-ink [overflow-wrap:anywhere]">{e.value}</Td>
                    <Td>{e.confidence ? <Pill tone={e.confidence === 'high' ? 'good' : e.confidence === 'medium' ? 'neutral' : 'warn'}>{e.confidence}</Pill> : <Dash />}</Td>
                    <Td className="min-w-[120px] text-[12px] text-ink-muted">{[e.method.replace(/_/g, ' '), e.actor_name].filter(Boolean).join(' · ')}</Td>
                    <Td className="whitespace-nowrap tabular-nums text-[12px] text-ink-faint">{e.last_checked_at ? shortDate(e.last_checked_at) : <Dash />}</Td>
                    <Td>{safeHref(e.evidence_url) ? <a href={safeHref(e.evidence_url)!} target="_blank" rel="noreferrer noopener" className="text-accent">source</a> : <Dash />}</Td>
                  </tr>
                ))}
              </Table>
            ) : (
              <EmptyNote>No research findings yet.</EmptyNote>
            )}
          </Section>

          <Section title="Verification history" meta={verificationMeta(d)}>
            {d.verification.length ? (
              <Table head={['Email', 'Checked by', 'Result', 'Cost', 'When']}>
                {d.verification.map((v) => (
                  <tr key={v.id}>
                    <Td className="max-w-[200px] truncate text-ink">{v.email}</Td>
                    <Td className="whitespace-nowrap text-ink-muted">{PROVIDER_LABEL[v.provider] ?? v.provider}</Td>
                    <Td className="whitespace-nowrap"><VerificationPill status={v.verdict === 'pass' ? null : (v.verdict as VerificationStatus)} />{v.verdict === 'pass' ? <Pill tone="neutral">Passed free check</Pill> : null} <span className="ml-1 text-[11px] text-ink-faint">{v.result}{v.sub_result ? ` / ${v.sub_result}` : ''}</span></Td>
                    <Td className="whitespace-nowrap text-right tabular-nums text-ink-muted">${Number(v.cost_usd).toFixed(4)}</Td>
                    <Td className="whitespace-nowrap tabular-nums text-ink-faint">{dateTime(v.checked_at)}</Td>
                  </tr>
                ))}
              </Table>
            ) : (
              <EmptyNote>No email on this lead has been checked yet.</EmptyNote>
            )}
          </Section>

          <Section title="Campaign activity" meta={`${d.touches.length}`}>
            {d.touches.length ? (
              <ol className="divide-y divide-line-soft">
                {d.touches.map((t) => {
                  const snippet = typeof t.payload?.reply_text_snippet === 'string' ? t.payload.reply_text_snippet : null
                  return (
                    <li key={t.id} className="px-4 py-2.5 text-[13px]">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium text-ink">{EVENT_LABEL[t.event_type] ?? t.event_type.replace(/_/g, ' ')}</span>
                        <span className="text-[12px] tabular-nums text-ink-faint">{dateTime(t.occurred_at)}</span>
                      </div>
                      <div className="text-[12px] text-ink-faint">{[t.campaign_name, t.email].filter(Boolean).join(' · ')}</div>
                      {snippet ? <p className="mt-1 line-clamp-3 break-words text-[12px] text-ink-muted">“{snippet}”</p> : null}
                    </li>
                  )
                })}
              </ol>
            ) : (
              <EmptyNote>Not in any Instantly campaign yet.</EmptyNote>
            )}
          </Section>
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          <Section title="Comments" meta={`${d.comments.length}`}>
            <div className="px-4 py-3">
              {d.comments.length ? (
                <ul className="flex flex-col gap-3">
                  {d.comments.map((cm) => (
                    <li key={cm.id} className="text-[13px]">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-medium text-ink">{cm.author_name}</span>
                        <span className="text-[11px] tabular-nums text-ink-faint">{dateTime(cm.created_at)}</span>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-ink-muted">{cm.body}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-ink-faint">No comments yet.</p>
              )}
              <CommentForm companyId={c.id} handles={d.actors.filter((a) => a.kind === 'agent').map((a) => a.id)} />
            </div>
          </Section>

          <Section title="Tasks" meta={`${d.tasks.length}`}>
            {d.tasks.length ? (
              <ul className="divide-y divide-line-soft">
                {d.tasks.map((t) => (
                  <li key={t.id} className="px-4 py-2.5 text-[13px]">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-ink">{t.title}</span>
                      <Pill tone={t.status === 'done' ? 'good' : t.status === 'failed' ? 'bad' : t.status === 'needs_approval' ? 'warn' : 'neutral'}>{t.status.replace(/_/g, ' ')}</Pill>
                    </div>
                    <div className="text-[12px] text-ink-faint">
                      {[t.claimed_by ? `by ${t.claimed_by}` : t.assigned_to ? `for ${t.assigned_to}` : 'unclaimed', shortDate(t.updated_at)].join(' · ')}
                    </div>
                    {t.report ? <p className="mt-1 line-clamp-3 text-[12px] text-ink-muted">{t.report}</p> : null}
                    {t.error ? <p className="mt-1 text-[12px] text-bad">{t.error}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyNote>No tasks for this lead.</EmptyNote>
            )}
          </Section>

          <Section title="History" meta={`${d.history.length}`}>
            {d.history.length ? (
              <ol className="divide-y divide-line-soft">
                {d.history.map((h) => (
                  <li key={h.id} className="px-4 py-2 text-[12px]">
                    <div className="text-ink-muted">
                      {h.entity_type === 'contact' ? <span className="text-ink-faint">{h.email ?? 'contact'} · </span> : null}
                      {historyLine(h.field, h.old_value, h.new_value)}
                    </div>
                    <div className="tabular-nums text-ink-faint">
                      {dateTime(h.changed_at)} · {h.changed_by_name ?? h.changed_by ?? 'not recorded'}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyNote>No changes recorded.</EmptyNote>
            )}
          </Section>

          <Section title="Sources" meta={`${d.sources.length}`}>
            {d.sources.length ? (
              <ul className="divide-y divide-line-soft">
                {d.sources.map((s) => (
                  <li key={s.id} className="px-4 py-2 text-[12px]">
                    <div className="text-ink">{s.kind.replace(/_/g, ' ')}{s.source_ref ? <span className="text-ink-faint"> · {s.source_ref}</span> : null}</div>
                    <div className="flex justify-between gap-2 text-ink-faint">
                      {safeHref(s.url) ? <a className="truncate text-accent" href={safeHref(s.url)!} target="_blank" rel="noreferrer noopener">{s.url}</a> : <span />}
                      <span className="shrink-0 tabular-nums">{shortDate(s.observed_at)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyNote>No sources recorded.</EmptyNote>
            )}
          </Section>
        </aside>
      </div>
    </PageShell>
  )
}

function verificationMeta(d: LeadDetail): string {
  const n = d.verification.length
  if (!n) return '0'
  const spent = d.verification.reduce((s, v) => s + Number(v.cost_usd), 0)
  return `${n} check${n === 1 ? '' : 's'} · $${spent.toFixed(4)} spent`
}

function historyLine(field: string, from: string | null, to: string | null): string {
  const label = (v: string | null) => (v && field === 'stage' && v in STAGE_LABELS ? STAGE_LABELS[v as Stage] : v ?? '')
  const name = FIELD_LABELS[field] ?? field.replace(/_/g, ' ')
  if (from === null) return `${name} set to ${label(to)}`
  if (to === null) return `${name} cleared (was ${label(from)})`
  return `${name}: ${label(from)} → ${label(to)}`
}

function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section>
      <SectionHeader title={title} meta={meta} />
      <Card className="overflow-hidden">{children}</Card>
    </section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <dt className="w-[72px] shrink-0 text-[12px] text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children === null || children === undefined || children === '' ? <Dash /> : children}</dd>
    </div>
  )
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-[13px]">
        <thead className="border-b border-line bg-canvas/60 text-[11px] uppercase tracking-[0.05em] text-ink-faint">
          <tr>{head.map((h) => <th key={h} className="whitespace-nowrap px-4 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line-soft">{children}</tbody>
      </table>
    </div>
  )
}

function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-2 align-top ${className}`}>{children}</td>
}

function Dash() {
  return <span className="text-unavailable">—</span>
}

/** Ready-personalized / Ready-generic / Parked under every rule set for this lead's pool (live, same evaluator as everywhere). */
function Readiness({ list, contacts }: { list: LeadReadiness[]; contacts: LeadDetail['contacts'] }) {
  if (!list.length) return null
  const email = (cid: number | null) => contacts.find((c) => c.id === cid)?.email ?? null
  return (
    <Section title="Ready for campaigns" meta="Scored live against the lead rules">
      <ul className="divide-y divide-line-soft">
        {list.map(({ ruleSet, verdict }) => (
          <li key={ruleSet.id} className="px-4 py-2.5 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <TierPill tier={verdict.tier} />
              <Link href={`/rules/${ruleSet.id}`} prefetch={false} className="font-medium text-ink hover:text-accent">
                {ruleSet.name}
              </Link>
              {verdict.contact_id ? <span className="text-[12px] text-ink-faint">via {email(verdict.contact_id) ?? `contact ${verdict.contact_id}`}</span> : null}
            </div>
            {verdict.reasons.length ? (
              <ul className="mt-1 list-disc pl-5 text-[12.5px] text-ink-muted">
                {verdict.reasons.map((r, i) => (
                  <li key={i}>
                    {r.label}: {r.detail}
                    {r.standing ? <span className="text-ink-faint"> (standing rule)</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {verdict.tier !== 'parked' && verdict.batch === 'role-inbox' ? (
              <p className="mt-1 text-[12.5px] text-ink-muted">Role inbox: goes out only in a role-inbox batch, with no-name copy.</p>
            ) : null}
            {verdict.tier !== 'parked' && verdict.batch !== 'role-inbox' && verdict.missing.length ? (
              <p className="mt-1 text-[12.5px] text-ink-muted">Generic because these have no real value: {verdict.missing.join(', ')}</p>
            ) : null}
            {verdict.tier !== 'parked' && Object.keys(verdict.merge).length ? (
              <p className="mt-1 text-[12px] text-ink-faint [overflow-wrap:anywhere]">
                Would send: {Object.entries(verdict.merge).map(([k, v]) => `{{${k}}} = “${v}”`).join(' · ')}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  )
}
