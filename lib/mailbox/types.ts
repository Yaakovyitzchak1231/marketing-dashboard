/**
 * Connected mailboxes on the lead profile (TAP-114, plan 6.10): the 1:1 emails
 * Yaakov exchanged with a lead's addresses, read live from his own inbox.
 *
 * Read-only by design. A provider only ever lists messages; nothing here sends,
 * moves, flags or deletes mail, and no message body is stored in the database.
 *
 * Outlook (Microsoft Graph, Mail.Read) is the first provider. Gmail slots in
 * later as a second `MailboxProvider` (gmail.readonly, query
 * `from:x OR to:x OR cc:x`) without touching the profile page: the page asks
 * every connected provider and merges what comes back.
 */

export type MailboxProviderId = 'outlook' | 'gmail'

export interface MailboxMessage {
  provider: MailboxProviderId
  /** The provider's own message id. */
  id: string
  /** 'sent' = from the connected mailbox to the lead; 'received' = from the lead. */
  direction: 'sent' | 'received'
  subject: string
  /** ISO time: sentDateTime for sent mail, receivedDateTime for received mail. */
  at: string
  from: string
  to: string[]
  cc: string[]
  /** The provider's own short preview of the body (Graph's bodyPreview). */
  preview: string
  /** Opens the message in the provider's web app, when the provider gives one. */
  webLink: string | null
  conversationId: string | null
  /** Which of the lead's addresses this message matched. */
  matched: string
}

export interface MailboxProvider {
  id: MailboxProviderId
  label: string
  /** The connected mailbox's own address, e.g. Yaakov@TapDash.co. */
  address: string
  /** Every 1:1 message between this mailbox and one address, newest first, at most `limit`. */
  messagesWith(address: string, opts: { limit: number }): Promise<{ messages: MailboxMessage[]; truncated: boolean }>
}

/** What one provider answered for a lead. */
export type ProviderResult =
  | { provider: MailboxProviderId; label: string; address: string; status: 'ok'; messages: MailboxMessage[]; truncated: boolean }
  | { provider: MailboxProviderId; label: string; address: string; status: 'error'; error: string }

/** The whole panel's state for one lead. */
export type LeadMailboxState =
  | { state: 'off' }
  | { state: 'not_configured'; missing: string[] }
  | { state: 'not_connected' }
  | { state: 'no_addresses' }
  | { state: 'read'; results: ProviderResult[]; messages: MailboxMessage[]; addresses: string[]; truncated: boolean }
