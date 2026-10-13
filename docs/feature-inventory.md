# Feature inventory (UI rebuild)

Every page, tab, form, button, action, filter, export, inline edit and link in
the app as it stood on `main` at `315c899` (before the UI rebuild). The rebuild
must not lose any of them. Each item is checked off with **where it lives now**
once the rebuild is done.

Legend: `[ ]` not yet verified in the new UI · `[x]` carried over (→ new location).

## App shell (components/nav/AppNav.tsx, app/layout.tsx)

- [ ] Brand link "TapDash" → `/`
- [ ] Top-bar links to 17 screens: Overview, Leads, Find leads, Verification, Campaigns, Lead rules, Segments, Suppressions, Replies, SEO / AI, Team, Agents, Settings, Tools, Activity, Reports, Jobs
- [ ] "More" menu with screens that don't fit (and its "More · X" label for the current hidden screen) — *to be removed per brief; replaced by grouped rail*
- [ ] Phone "Menu" drawer listing every screen, grouped; closes on Escape / tap / route change; locks page scroll
- [ ] Inbox link → `/agents/owner` with live unread badge (shared `/api/live` EventSource)
- [ ] Hidden on `/login`
- [ ] Page comment layer on every page (pins, "Comment" pick mode, "My comments" tray, drafts autosave, send one / send all drafts, replies, resolve, show/hide pins, show resolved, recipient picker, tags Needs fix / Question / Idea, delete draft, view-only note for viewers, close box when leaving page)
- [ ] View-only guard (viewer toast on write attempts)
- [ ] Global error boundary (`app/error.tsx`) and loading state (`app/loading.tsx`)
- [ ] Print styles for the weekly one-pager

## Login (`/login`)

- [ ] Email + password sign-in form, error messages, `?next=` redirect

## Overview (`/`)

- [ ] Meta: total leads · email addresses
- [ ] Auto-refresh every 30s
- [ ] Setup checklist (N of 6 done, item links, Dismiss)
- [ ] "What needs you" tiles: Replies waiting → `/replies`; Interested → `/replies#interested`; Ready (personalized / generic / parked / re-scoring) → `/rules` or Ready to send → `/leads?verification=valid`; Needs verification → `/leads?view=verify`; Needs research → `/leads?view=research`; In campaigns → `/leads?view=campaign`
- [ ] "Why leads are parked" list + scored/stale counts + link to Lead rules
- [ ] "Leads by stage" bars, each stage → `/leads?stage=…`; "Open board" → `/leads?view=kanban`
- [ ] "Team at work": tasks in progress / waiting / need your OK (→ `/team`), who is working now; "Team board" link
- [ ] "Latest activity" (5 most recent events) + "All activity" link
- [ ] Background re-score kick when readiness is stale (server side, unchanged)

## Leads (`/leads`)

- [ ] Header actions: Find duplicates → `/leads/duplicates`; Import CSV → `/leads/import`; Add lead → `/leads/add`
- [ ] Views: Table / By stage (kanban) / By campaign / By state, plus "Needs research" and "Needs verification" views (URL `view=`)
- [ ] Filter bar (GET form): search `q`, state, stage, campaign, pool/segment, has email, owner, job filter ("show all" clears job); Apply / Clear all
- [ ] Advanced filters drawer (segment `?seg=` or ad-hoc `?f=` conditions; tabs; add/remove rows; Apply; Clear; Save as segment)
- [ ] "Filtered by segment …" note
- [ ] Table: select-all / per-row checkbox, sortable columns (Lead, Place, Stage, Email, Verified, Campaign, Updated), Score pill, "Open →" link
- [ ] Inline edit: company Name and Stage (with history drawer / ask-to-change)
- [ ] Phone list layout of the same rows
- [ ] Bulk bar: Research selected; Verify selected; Add to Instantly → `/leads/instantly?companies=…`; Set stage (Apply); Add tag; Add to list; Bulk edit field (Apply to …, Confirm, Cancel); Clear selection
- [ ] Pagination (Previous / Next with range)
- [ ] Kanban: column per stage with count, cards with stage menu, "All N in stage" link
- [ ] By campaign groups → filtered table; By state table → filtered table and state+stage cells
- [ ] "Verify all matching" (Needs verification view) → `/verify?…`
- [ ] Empty states (no leads / no match / segment empty)

## Lead detail (`/leads/[id]`)

- [ ] Back link ← All leads; profile tabs (overview / engagement / timeline / files …)
- [ ] Edit fields form (company + contacts), custom fields block
- [ ] Stage select, milestones, reachability, score/tier with link to its rule set
- [ ] Contacts with verification pills, VerifyButton, "Forget this person" (confirm)
- [ ] Owner research enqueue, research evidence links (source)
- [ ] Campaigns card (→ `/campaigns/[id]`), Segments card (→ `/segments/[id]`), Lead lists card (add to list / new list / remove)
- [ ] Files card (add link: name, url, note; remove)
- [ ] Comment form + comments
- [ ] Engagement panel, timeline with category filter + search + Clear
- [ ] Website link

## Add lead (`/leads/add`), Import (`/leads/import`), Duplicates (`/leads/duplicates`), Add to Instantly (`/leads/instantly`)

- [ ] Add lead form: first/last name, email, phone, title, company, website, company phone, city, state, pool, campaign
- [ ] Import wizard: paste/upload CSV → map columns → preview → Import N rows; Back; Go to Leads
- [ ] Duplicates: candidate pairs, pick keep side, field-by-field keep/merge, "Merge #a into #b"
- [ ] Add to Instantly: campaign select, batch select, Preview (rules preview, link to rule set), lead list links, link to Activity › Needs your OK, Back to Leads

## Find leads (`/find`)

- [ ] Find form: pool/segment chips (Jewelers / AI agencies / AI builders / Other), Where, Max businesses, Searches textarea, 10 step checkboxes (find businesses, read websites, owner search, maps reviews, Yelp owner, owner last name, Facebook page, email pattern, add to Leads, rotate proxies), submit "Find leads"
- [ ] `?segment=` preselect (from runway "Find more leads")
- [ ] Recent jobs (2): status, metrics, narrative, "See the N leads from this job" → `/leads?job=`, "Task thread" → `/team/[id]`, Cancel job (confirm)
- [ ] Terms-of-service note about Maps scraping

## Verification (`/verify`)

- [ ] Provider cards (MillionVerifier, ZeroBounce) with key status and links to Settings, price per check
- [ ] Emails by status counts
- [ ] Check leads selector: state, stage, email status, pool, search, at most N, include option; contact-id mode ("Use a filter instead")
- [ ] Run free check → cost preview → Approve paid run (high-spend confirm) / Cancel run / Check more leads
- [ ] Recent runs list → `/verify?run=`; run detail with progress
- [ ] Gate for viewers

## Campaigns (`/campaigns`)

- [ ] Header: New campaign → `/campaigns/new`; Instantly performance → `/campaigns/performance`
- [ ] Pool filter chips + Show archived toggle
- [ ] Campaign list (→ `/campaigns/[id]`), Archive (confirm)
- [ ] Templates list
- [ ] Quick create form: name, pool, goal (GoalPicker incl. custom), start from (blank / recipe / copy), copy leads too
- [ ] Statuses editor: list, Turn off / Turn on, add status (id, label, archived)

## Campaign detail (`/campaigns/[id]`, `/steps`, `/profile`, `/new`, `/performance`)

- [ ] Tabs: Campaign / Steps / Profile (CampaignTabs)
- [ ] Duplicate (with leads / as template), Save as template, Give this campaign its own rules, edit rules link
- [ ] Tier filter chips, search/state filter, Clear
- [ ] Lead list with select + "Remove selected from this campaign", Edit lead overrides (contact, tags, note, overrides JSON) in side panel, close
- [ ] Add leads by filter (pool, stage, contact status, verification, tag, state; Count matches → Add N), by ids, from segment (keep syncing, exclude segment)
- [ ] Archive campaign (confirm); pagination
- [ ] Steps editor: add / edit / delete / reorder steps and variants, lead preview (refresh), experiments (create, start, pause, resume, evaluate, record, declare winner, results), push leads to Instantly (request), withdraw request, link to approvals
- [ ] Profile wizard (4 steps: basics + pool / approve-reject search phrases / KPIs / done-make-active), re-check, create pool
- [ ] New campaign form ("Create and set up profile")
- [ ] Instantly performance: range selector (7/30/90/custom), Refresh, KPIs, insights, daily chart, campaign table (sort, expand, show idle), sending accounts table, replies list, sequence plan (show all days), notices (dismiss), sample-data banner

## Scoring & rules (`/rules`, `/rules/[id]`)

- [ ] Rule sets table (name, version, scope, counts ready-personalized / ready-generic / parked, re-scoring state) → `/rules/[id]`
- [ ] Pending proposals → rule set
- [ ] Create campaign rules (campaign id, name, pool, copy of) and Create template forms
- [ ] Standing rules (read-only list)
- [ ] Rule set editor: requirements / fields with reorder ↑↓ / remove, owner-research toggle (confirm), Save and re-score (with note, base version conflict), Re-score all leads now, Archive (confirm), proposals Apply / Reject

## Segments (`/segments`, `/segments/new`, `/segments/[id]`, `/segments/[id]/stats`, `/segments/traits`)

- [ ] New segment; Start from a template (template, campaign scope, Create from template)
- [ ] All segments table (name, campaign, kind, companies, contacts, verified-sendable, last snapshot) → segment
- [ ] Segment builder: include/exclude groups, field/event/quality conditions, AI "Describe it", static members remove, Save, Back
- [ ] Segment stats with size sparkline
- [ ] Traits: define trait (key, label, entity, event types, aggregation, prop, window, filter), Preview on 5 leads, Save trait, Archive

## Suppressions (`/suppressions`)

- [ ] Add: email or domain, reason, campaign id (blank = all), note, expires at
- [ ] Import CSV: paste text or file upload, default reason, Import
- [ ] Export CSV (`/api/suppressions/export`)
- [ ] Search filter; list (email/domain, scope, reason, source, note, added); Lift (remove)

## Replies (`/replies`)

- [ ] Bucket jump chips with counts (Needs a reply, Interested, Not now, Auto-replies, Unsubscribed, Bounced, Answered)
- [ ] Buckets with notes; reply rows (lead link, place, email, campaign, subject, snippet, time, Open in Unibox ↗); quiet buckets compact (8 + "and N more")

## SEO (`/seo/*`)

- [ ] Sub-nav: Overview / Sites / Technical audit / AI visibility / Citations & actions / Fix list / Search Console
- [ ] Overview: sites with pass/fix/improve/blocked counts, Re-run all audits, Re-run / Run audit, details, open fixes link; AI answers status; top fixes
- [ ] Sites: add site (url, name, platform, host, campaign, pages), Run audit, toggle active
- [ ] Technical audit: site picker, checks with reasons, history, Re-run audit, fix list link
- [ ] AI visibility: Run check now (per provider), questions (add, toggle), competitors (add, remove)
- [ ] Citations: site filter, runs, cited URLs, View site, Queue content review, Prepare WordPress draft task
- [ ] Fix list: by site filter, fixes → detail
- [ ] Fix detail: preview change / draft, apply WordPress change (hide from Google, move to draft), assign, mark done, dismiss, reopen, undo, evidence link, task thread link
- [ ] Search Console page

## Team (`/team`, `/team/[id]`)

- [ ] Project chips + person chips filters
- [ ] Task cards (title, priority, kind, project, assignee state, notes, age)
- [ ] Add to the board: title, details, who, project, priority
- [ ] Task thread: post comment, I'll take it, Hand off (to), Mark blocked / Unblock / Mark done / Cancel (with note), lead link, Activity link, Team board link

## Agents (`/agents`, `/agents/[id]`, `/agents/owner`)

- [ ] Fleet cards (presence, seen, status note, on it / waiting / checked out / notes counters, unread), Pause all agents, per-agent Pause / Resume (confirm, reason), Add agent (name, short id, harness)
- [ ] Agent page: pause/resume, admin card (rename, can-send toggle, disable / re-enable with confirm), working on now, waiting, reports, memory (edit, delete, add note), connect panel (channels add/toggle/remove, send message, keys revoke, Shabbos quiet hours toggle), give a task form, inbox with Mark all read and delivery chips, checked out, recent activity, shared team notes
- [ ] Owner page = the old "Inbox" destination

## Activity (`/activity`)

- [ ] Kind chips (Everything, Tasks, Instantly, Verification, Research, Find leads, Approvals, Checkouts, Memory, Pauses) and actor chips
- [ ] Day-grouped feed (time, summary, task link, agent name), "Older" pagination, auto-refresh 15s
- [ ] Needs your OK: approval cards (pill, requester, age, summary, value-change detail + open lead, est. cost, open task, Approve / Reject with note, Instantly approval card with lead list and "See every lead")
- [ ] Checked out: locks with holder, note, since, Take back

## Reports (`/reports`, `/weekly`, `/runway`, `/costs`)

- [ ] Running low on leads alerts + Open runway
- [ ] Report cards → weekly / runway / costs
- [ ] Lead Master copy: Download CSV (`/api/reports/lead-master`), sheet-write status, export history
- [ ] Weekly: numbers, best/worst angle, runway, open items with Assign follow-up (title, detail, assignee), Print / Save as PDF, Markdown (`/api/reports/weekly?format=md`)
- [ ] Runway: per segment/campaign days left, Find more leads → `/find?segment=`, Set segments → costs
- [ ] Costs: range chips, add cost (month, category, label, campaign, amount), remove, campaign setup (segment, angle) Save

## Jobs (`/jobs`)

- [ ] Runner online status
- [ ] Job list: name, kind, description, schedule, timezone, next run, last run status, Disable/Enable, Run now
- [ ] Add a job: name, enabled, kind, description, cron, timezone, campaign, timeout, payload JSON, Save job
- [ ] Recent runs with errors

## Tools (`/tools`)

- [ ] Campaign filter chips
- [ ] Tool cards (name, description, Open link, health)
- [ ] Data sources health table (last event, 24h volume, status, last error)
- [ ] Add / edit a tool (id, name, kind, reachable from, description, url, api url, sort, active)

## Settings (`/settings` and sub-pages)

- [ ] Secrets read-only banner when the settings key is missing
- [ ] Needs setup index with anchors
- [ ] Agent delivery readiness
- [ ] Links: Scoring, Tags, Pools, Event types, Fields, Users & roles
- [ ] Setting groups from the registry: text/select/multiline fields with Save, AI model picker (list, refresh, type your own), quiet hours (start/end, Clear), secret fields (Replace, Clear with confirm, Test), mail-in-use summary, timezone, date format
- [ ] Integrations: per-tool API key and URL
- [ ] Data: retention policies (keep days), Run sweep (preview, include timeline, confirm, cancel)
- [ ] Team: members, add (name, email, role), change role, remove (confirm)
- [ ] Agents: task kinds each agent takes (save, clear)
- [ ] `/settings/users`, `/settings/fields` (add field, archive), `/settings/tags` (style, rename/merge with preview + confirm), `/settings/pools` (edit, create), `/settings/scoring` (rules JSON, thresholds JSON, max points, Save, Recompute all now), `/settings/event-types` (register, relabel, activate)
- [ ] `/setup` → redirect to `/settings`

## Legacy pages (not in the old nav)

- [ ] `/angles` (angle manager: add, delete, sort, export visible CSV; provenance panel)
- [ ] `/ideas` (idea manager: add, delete, sort, export visible CSV)
- [ ] `/costs` (cost manager: add, delete, export visible CSV)
- [ ] `/workspace` (shared workspace: revisions, restore, approvals approve / request changes / dismiss, comments)
