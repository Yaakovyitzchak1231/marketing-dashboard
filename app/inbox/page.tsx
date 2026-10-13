import { redirect } from 'next/navigation'

/**
 * The nav's Inbox destination. Until a dedicated inbox screen exists, it is
 * the owner's agent page (replies, approvals, notifications), which is where
 * the old top bar's Inbox link went. The nav still highlights Inbox there
 * (nav-config matches /agents/owner to /inbox).
 */
export default function InboxPage(): never {
  redirect('/agents/owner')
}
