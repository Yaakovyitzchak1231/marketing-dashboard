import type { Metadata, Viewport } from 'next'
import './globals.css'
import { AppShell } from '@/components/shell/AppShell'
import { THEME_BOOT_SCRIPT } from '@/components/shell/preferences'
import { PageComments } from '@/components/comments/PageComments'
import { ViewOnlyGuard } from '@/components/auth/ViewOnlyGuard'

/**
 * Document metadata. Deliberately plain -- no OpenGraph image, no splash, no
 * manifest. This is an internal tool.
 */
export const metadata: Metadata = {
  title: { default: 'TapDash', template: '%s · TapDash' },
  description: 'Leads, verification, campaigns and replies in one place.',
}

/** viewport-fit=cover so the phone bottom bar can sit above the home indicator. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f7f4' },
    { media: '(prefers-color-scheme: dark)', color: '#161513' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <AppShell>
          {children}
          <PageComments />
        </AppShell>
        <ViewOnlyGuard />
      </body>
    </html>
  )
}
