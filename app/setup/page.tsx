import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/** /setup now lives at /settings. */
export default function SetupPage() {
  redirect('/settings')
}
