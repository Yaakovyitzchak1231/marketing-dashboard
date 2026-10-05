# Copy Deck

Sections 1–7 are the seven honest dashboard states. Section 8 is the shared workspace.
All copy is plain, direct, and specific. No hype. No invented numbers.

Runtime source is `lib/copy.ts`. This deck is the review copy of those strings.
Components import `COPY` and do not retype the words.

## 1. Metric unavailable

Use when a metric exists in the UI but is not reported by the Instantly API.

- `open_rate` label/placeholder: **Not reported by Instantly**
- `unsubscribe` label/placeholder: **Not reported by Instantly**

Why: the API does not populate these values. Showing `0.0%` implies a measurement. This copy says the API did not report one.

## 2. Rate that cannot be trusted

Use when reply rate exceeds `100%` or the backend flags it as unreliable.

- Inline suppression text: **Reply rate is unreliable. Autoresponders are included in this count.**

Why: `333%` and `450%` have appeared because autoresponders were counted as human replies. This copy makes the problem visible instead of hiding it behind a tooltip.

## 3. Empty history / first run

Use when the trend chart has no stored rows yet.

- Trend empty state: **Collecting history**

Why: it tells the user the system is working, not that the chart is broken or blank.

## 4. Stale data

Use on the last-updated line near the top of the dashboard.

- Healthy: **Collected <timestamp>**
- Failed collection: **Last collection failed**

Why: show when data was last collected. If collection failed, say that plainly instead of showing old data as fresh.

## 5. Partial list

Use when the campaign list is truncated or otherwise incomplete.

- Example rendered string: **Showing 2 of 148 campaigns**

Pass the visible count and total count. Never render a silently short list without saying it is partial.

## 6. Loading

Use while a fetch is in flight.

- Loading state: **Loading**

## 7. Error

Use when a fetch fails.

- Error text: **Something went wrong. Try again.**

This gives one action without overpromising help text.

## 8. Shared workspace

Use for the shared-workspace section. Import `COPY.workspace`. Do not retype these strings in a component.

The section is the same dashboard and the same data. It does not add a price, a second artifact, or a public link.

Actors are passed through. A human is an email. An agent is `agent:<profile>`, for example `agent:build-data`. Never default an author. If the actor was not recorded, the UI says **Author not recorded**, not a dash and not a zero.

### Heading

- Title: **Shared workspace**
- What it is: **Same live artifact. One current version.**
- Who is in it: **The owner, and agents that authenticate as themselves.**
- What it costs: **Nothing. Same dashboard, same data.**

### Artifact and revisions

- **Same live artifact**
- **One current version**
- **Change history**
- **Revisions stay local unless shared**
- **Restore this version**
- Restore note: **Restore this version. The current version stays in change history.**
- Saved by: **Saved by <actor or agent:build-data>**
- Missing author: **Author not recorded**
- Column labels: **Change**, **Note**, **When**
- **Save** — **Save names the current version in change history.**
- **Pin this version** — **Pin this version. The workspace opens it by default.**
- Empty history: **No revisions yet**

A failed load is **Something went wrong. Try again.** It is not **No revisions yet**. An empty list and a failed load are different facts.

### Approval and ownership

- **Owner: <email>**
- Missing owner: **Owner not recorded**
- **Last changed by <actor>**
- **Approved by**
- With an actor: **Approved by <actor>**
- **No approvals yet**
- First run, nothing submitted: **No approval needed yet**
- **Approve**
- **Request changes to <owner>**
- **Dismiss**
- **Dismiss keeps the reason with this approval.**
- **Dismissed by <actor>**
- Reason label: **Reason**

Do not render **Approved by** with no actor. That is a dangling approval. Do not render the word approved on its own.

### Comments

- **Comments**
- **No comments yet**
- **Comment on <row name>**

### Boundary

- **Open to ideas. Closed to chaos.**
- Current local state: **Local context can stay local.**
- **Every approval has an owner.**
- **Every revision has a history.**
- **Agents authenticate as agents. Permissions are explicit. Your work remains yours.**
- Current shared state, only when a share grant exists: **Shared with agents**

The local sentence is a rule and, when nothing has been shared, the badge. Do not show **Shared with agents** as decoration. The page badge stays on **Local context can stay local.** until a grant exists.

### Words that do not belong here

Do not write sync, collaboration, synergy, or an exclamation mark. Do not use an emoji as a jar, a badge, or decoration.
