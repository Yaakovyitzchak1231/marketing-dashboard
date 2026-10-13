import type { ReactNode } from 'react'
import { SetupNeeded } from './SetupNeeded'

import { PageHeader as UiPageHeader } from '@/components/ui/PageHeader'
import { buttonClass } from '@/components/ui/Button'

/**
 * The title row every screen shares: title, the one line saying what the
 * page is for, live context (`meta`), and actions. The last action is the
 * page's primary one.
 */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  back,
}: {
  title: string
  description?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  back?: { href: string; label: string }
}) {
  return <UiPageHeader title={title} description={description} meta={meta} primary={actions} back={back} />
}

/** The page container: one width, one rhythm, room for the phone's bottom bar. */
export function PageShell({
  title,
  description,
  meta,
  actions,
  back,
  children,
  wide,
}: {
  title: string
  description?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  back?: { href: string; label: string }
  children: ReactNode
  wide?: boolean
}) {
  return (
    <main className={`mx-auto w-full ${wide ? 'max-w-[1480px]' : 'max-w-shell'} px-4 pb-bottom-nav pt-6 sm:px-6 lg:px-8 lg:pt-8`}>
      <PageHeader title={title} description={description} meta={meta} actions={actions} back={back} />
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
          {what} needs the lead database, and it isn&rsquo;t connected to this deployment yet. Nothing here is estimated or filled in
          while it&rsquo;s missing.
        </>
      }
    />
  )
}
/** Legacy names: the design system's secondary and primary buttons. */
export const BUTTON = buttonClass({ variant: 'secondary', size: 'md' })
export const BUTTON_PRIMARY = buttonClass({ variant: 'primary', size: 'md' })
