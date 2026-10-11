import type { ReactNode } from 'react'
import { PageShell } from '@/components/app/PageShell'
import { SeoNav } from '@/components/seo/SeoNav'

export default function SeoLayout({ children }: { children: ReactNode }) {
  return (
    <PageShell title="SEO / AI visibility" meta="Search visibility, sampled AI answers and evidence-backed improvements. Provider checks run on request; publishing stays under your control.">
      <SeoNav />
      {children}
    </PageShell>
  )
}
