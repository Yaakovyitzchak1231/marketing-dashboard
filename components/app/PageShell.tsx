import type { ReactNode } from 'react'
import { SetupNeeded } from './SetupNeeded'

/** The title row every screen shares: title, one line of meta, an actions slot. */
export function PageHeader({ title, meta, actions }: { title: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-ink [overflow-wrap:anywhere]">{title}</h1>
        {meta ? <p className="mt-0.5 text-[12px] leading-snug text-ink-faint [overflow-wrap:anywhere]">{meta}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function PageShell({
  title,
  meta,
  actions,
  children,
}: {
  title: string
  meta?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <main className="mx-auto max-w-shell px-4 pb-16 pt-5 sm:px-6 sm:pt-6">
      <PageHeader title={title} meta={meta} actions={actions} />
      {children}
    </main>
  )
}

/** DATABASE_URL is not set: say so, show no numbers, and say exactly how to set it. */
export function DbNotConnected({ what }: { what: string }) {
  return (
    <SetupNeeded
      features={['leads']}
      testId="db-not-connected"
      title="The lead database isn’t connected"
      intro={
        <>
          {what} reads from the lead database, and this deploy has no <code className="rounded bg-canvas px-1 font-numeric text-[12px]">DATABASE_URL</code>{' '}
          yet. You don&rsquo;t type anything: Vercel creates the database and the key for you. Nothing here is estimated or filled in.
        </>
      }
    />
  )
}
/** A small button-like link in the house style. */
export const BUTTON =
  'inline-flex items-center rounded-card border border-line bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-50'
export const BUTTON_PRIMARY =
  'inline-flex items-center rounded-card border border-accent bg-accent px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50'
