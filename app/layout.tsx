import type { Metadata } from 'next'
import './globals.css'
import { AppNav } from '@/components/nav/AppNav'
import { PageComments } from '@/components/comments/PageComments'
import { ViewOnlyGuard } from '@/components/auth/ViewOnlyGuard'

/**
 * Document metadata. Deliberately plain -- no OpenGraph image, no theme-color
 * splash, no manifest. This is an internal tool, and dressing it up as a
 * product is the first step toward it looking like a template.
 */
export const metadata: Metadata = {
  title: 'Marketing dashboard',
  description: 'Leads, verification, campaigns and replies in one place.',
}

// No `viewport` export. The default initial scale is exactly what this page
// wants, and setting it by hand is a number in the render path that has to be
// argued about every time the theme changes. Omitting it is the honest choice:
// the browser already does the right thing.

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppNav />
        {children}
        <PageComments />
        <ViewOnlyGuard />
      </body>
    </html>
  )
}
