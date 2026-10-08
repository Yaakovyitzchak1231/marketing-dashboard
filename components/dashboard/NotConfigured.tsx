import { Card } from './primitives'

/** Shown when INSTANTLY_API_KEY is missing. No numbers at all, never placeholders. */
export function NotConfigured() {
  return (
    <Card className="mx-auto max-w-[620px] px-5 py-6 sm:px-7 sm:py-7">
      <div data-testid="not-configured">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-warn">Setup needed</p>
        <h2 className="mt-1.5 text-[18px] font-semibold tracking-[-0.01em] text-ink">Connect your Instantly account</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">
          This dashboard reads your campaigns live from Instantly. It has no API key yet, so there is nothing to show.
          No numbers on this page are estimated or filled in.
        </p>
        <ol className="mt-5 space-y-4 text-[14px] leading-relaxed text-ink">
          <Step n={1}>
            In Instantly, go to <b className="font-medium">Settings → Integrations → API Keys</b> and create a key.
            Read-only access is enough (the <code className="rounded bg-canvas px-1 font-numeric text-[12px]">all:read</code> scope).
          </Step>
          <Step n={2}>
            In Vercel, open this project&rsquo;s <b className="font-medium">Settings → Environment Variables</b> and add{' '}
            <code className="rounded bg-canvas px-1 font-numeric text-[12px]">INSTANTLY_API_KEY</code> with that key, for Production.
            Optionally set <code className="rounded bg-canvas px-1 font-numeric text-[12px]">DASHBOARD_TZ</code> (for example{' '}
            <code className="rounded bg-canvas px-1 font-numeric text-[12px]">America/New_York</code>) so days line up with yours.
          </Step>
          <Step n={3}>Redeploy. The dashboard fills in on the next load.</Step>
        </ol>
        <p className="mt-5 border-t border-line-soft pt-4 text-[12px] text-ink-faint">
          The key stays on the server. It is never sent to the browser.
        </p>
      </div>
    </Card>
  )
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-[1px] flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line font-numeric text-[12px] text-ink-muted">
        {n}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  )
}
