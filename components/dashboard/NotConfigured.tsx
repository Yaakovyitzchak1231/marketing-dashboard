import { SetupNeeded } from '@/components/app/SetupNeeded'

/** Shown when INSTANTLY_API_KEY is missing. No numbers at all, never placeholders. */
export function NotConfigured() {
  return (
    <SetupNeeded
      features={['dashboard']}
      testId="not-configured"
      title="Connect your Instantly account"
      intro="This dashboard reads your campaigns live from Instantly. It has no API key yet, so there is nothing to show. No numbers on this page are estimated or filled in. The key stays on the server and is never sent to the browser."
    />
  )
}
