import type { ReactNode } from 'react'
import { PageShell } from '@/components/app/PageShell'
import { SeoNav } from '@/components/seo/SeoNav'

export default function SeoLayout({ children }: { children: ReactNode }) {
  return (
    <PageShell title="SEO / AI visibility" meta="Google, plus the answers ChatGPT, Claude, Gemini and Perplexity give buyers. Free checks; models run only when their key is set.">
      <SeoNav />
      {children}
    </PageShell>
  )
}
