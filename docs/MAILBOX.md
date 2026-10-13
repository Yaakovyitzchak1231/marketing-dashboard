# Your emails on the lead page (TAP-114)

The lead page's **Timeline** tab can show an **Emails with you** list: the 1:1
emails between your own inbox and that lead's email addresses, both the ones you
sent and the ones they sent you, newest first, with a link to open each one in
Outlook.

It is **read-only**. The dashboard asks Microsoft for `Mail.Read` only, so it
can list mail but never send, move, flag or delete it. No message text is stored
in the database; each view reads Outlook live (cached for 5 minutes).

## What counts as a 1:1 email

A message counts when your connected inbox and one of the lead's addresses are on
opposite ends of it: the lead sent it, or you sent it with the lead in To or Cc.
Drafts never count, and neither does a message that only mentions the lead's
address in its text. Matching is by email address, across every contact on the
lead (up to 10 addresses), all folders. The list shows the latest 50.

## Turning it on

It is behind a feature flag and is off until all of this is done.

1. **Register an app in Microsoft Entra** (portal.azure.com → Microsoft Entra ID →
   App registrations → New registration), signed in as the TapDash Microsoft 365 admin.
   - Name: `TapDash dashboard (read mail)`.
   - Supported account types: "Accounts in this organizational directory only"
     (single tenant) is the tightest choice.
   - Redirect URI: platform **Web**,
     `https://marketing-dashboard-xi-five.vercel.app/api/mailbox/outlook/callback`
     (exactly this; add one per other domain the dashboard is opened on).
2. **API permissions** → Add a permission → Microsoft Graph → **Delegated** →
   `Mail.Read` (plus `offline_access`, `openid`, `profile`, `email`, which are
   sign-in basics). Do not add any Application permissions or any `Send` /
   `ReadWrite` permission. Grant admin consent if your tenant asks for it.
3. **Certificates & secrets** → New client secret → copy its **Value**.
4. In the dashboard, **Settings → Mailboxes**:
   - Microsoft app (client) ID: the Application (client) ID from the app's Overview.
   - Microsoft app client secret: the Value from step 3.
   - Microsoft tenant: the Directory (tenant) ID from the Overview (or leave empty for `common`).
   - Show Outlook emails on lead pages: **On**.
   (The same values can instead be set as Vercel env vars: `MS_GRAPH_CLIENT_ID`,
   `MS_GRAPH_CLIENT_SECRET`, `MS_GRAPH_TENANT`, `MAILBOX_OUTLOOK_ENABLED=on`.)
5. Open any lead → **Timeline** → **Connect Outlook**, and sign in as
   Yaakov@TapDash.co. Microsoft sends you back to the lead and the list appears.

Only an Owner can connect, and only an Owner sees the list: it is your private
mail, so editors and viewers see no section and nothing is read for them. To disconnect, clear **Outlook connection** in
Settings → Mailboxes (and, to cut access at Microsoft's end too, remove the app
under myaccount.microsoft.com → Apps). The client secret expires on the date
Microsoft shows for it; make a new one before then.

## How it works

- `lib/mailbox/outlook.ts`: Microsoft sign-in (authorization code, then refresh
  token) and the one Graph call, `GET /me/messages?$search="participants:<address>"`.
- `lib/mailbox/match.ts`: the 1:1 rules above, pure and tested.
- `lib/mailbox/server.ts`: reads the settings, decides the panel state, caches.
  Microsoft rotates the refresh token; the new one is saved at most once a day.
- `app/api/mailbox/outlook/connect/route.ts` and `app/api/mailbox/outlook/callback/route.ts`:
  the Connect round trip (Owner only, state cookie checked).
- `components/leads/MailboxEmails.tsx`: the panel.
- Secrets (client secret, refresh token) are encrypted in the settings store
  with `SETTINGS_KEY`, like every other key on /settings.

## Adding Gmail later

`lib/mailbox/types.ts` defines a `MailboxProvider`; Gmail becomes a second one
(OAuth scope `gmail.readonly`, search `from:<address> OR to:<address> OR cc:<address>`),
with its own settings under `mailbox.gmail.*` and its own Connect route. The panel
already merges every provider's results.
