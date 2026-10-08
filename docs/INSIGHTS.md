# Insights engine: every rule, threshold and formula (branch tab/insights)

Code: lib/insights/ (index.ts computeInsights + classifyAccountHealth, thresholds.ts, stats.ts, accounts.ts, campaigns.ts, steps.ts, leads.ts, trends.ts, severity.ts). The engine is pure and deterministic: it does no I/O, it treats DashboardData.generatedAt as "now", it never mutates its input, and its output does not depend on input order.

## Ground rules
- Every rate is recomputed from raw counts (k / n). A rate is null when n is null or 0, or when k > n (an impossible rate). We never average rates. Pooled figures are sum(k) / sum(n).
- A null count means "Instantly did not report it". It never counts as 0, and a rule whose inputs are null stays silent.
- Small samples: rankings use the Wilson 95% interval (z = 1.96). "Best" means the highest lower bound and "worst" means the lowest upper bound. A difference only counts as real when the intervals don't overlap, or when a two-proportion z-test gives |z| >= 1.96.
- The output is [] when configured is false or there is no data at all. We never make filler cards.
- Order: critical, then warning, then opportunity, then win. Inside each band, cards sort by impact (a fixed base per rule plus the size of the effect), then by id.
- Open tracking off: we say it once, inside the detail of the most relevant reply-rate card ("Open tracking is off, so opens are not measured (not a 0% open rate); replies are the signal."). It never gets a card of its own and never shows as a 0% problem.

## Thresholds (lib/insights/thresholds.ts)
- MIN_CONTACTED_TO_RANK = 100 leads contacted before a campaign gets ranked. Below that the card says "too early to judge".
- MIN_CONTACTED_FOR_ZERO_REPLY = 150. At 0 of 150 the upper bound is about 2.5%.
- MIN_SENDS_PER_VARIANT = 100 sends per A/B variant before variants are compared.
- MIN_SENDS_TO_CUT_STEP = 200 sends on a follow-up step with 0 replies before we suggest cutting it.
- MIN_SENDS_FOR_SUBJECT = 100. MIN_REPLIES_FOR_STEP_MIX = 20. FIRST_STEP_DOMINANT_SHARE = 70%. FOLLOWUPS_STRONG_SHARE = 40%.
- BOUNCE_WARN = 2% and BOUNCE_CRITICAL = 5% of sent. This is widely used cold-email guidance.
- MIN_SENT_FOR_TOTAL_BOUNCE = 100. MIN_SENT_FOR_ACCOUNT_BOUNCE = 50.
- WARMUP_WATCH = 90 and WARMUP_AT_RISK = 70, on Instantly's 0-100 score. These are judgment calls.
- Load balance flags an account at LOAD_MULTIPLE_OF_MEDIAN = 2x the median sending account. It needs at least 3 accounts that sent, and the heavy account must have at least 100 sends.
- FOLLOWUP_WARN_DAYS = 1 and FOLLOWUP_CRITICAL_DAYS = 3. MAX_LEAD_CARDS = 5.
- MIN_CONTACTED_FOR_TREND = 100 per period. MIN_SENT_FOR_VOLUME_TREND = 200. VOLUME_DROP_SHARE = 50%.
- STALL_DAYS = 3 finished days (today excluded). Using 3 means a weekend never fires it.
- LOW_RUNWAY_DAYS = 5.

## Sending accounts: classifyAccountHealth (the sender table and the callouts use the same findings)
- The status word is read loosely. Anything with error, disconnect, fail, invalid, suspend, banned or bounce, or a negative code like "-1", counts as an error. Pause, inactive, disabled, stopped or "2" counts as paused. Active, connected, ok or "1" counts as active.
- bounce rate = bounced / sent. It is only judged at 50 or more sends. If the bounced count is missing, Instantly's own bounceRate is used, but only when it is between 0 and 1.
- at_risk: an error status, bounce over 5%, or warmup under 70.
- watch: bounce over 2%, warmup under 90, or paused.
- healthy: none of the above, plus at least one real signal (bounce judged on 50+ sends, or a warmup score).
- unknown: nothing to judge on.
- healthReason lists every finding in plain words, worst first, e.g. "6.1% bounce (11 of 180 sent), over the 5% limit".

## Callouts
Deliverability
1. Workspace bounce (bounce-total) = totals.bounced / totals.sent at 100+ sends. Over 2% is a warning, over 5% is critical. Action: verify the lead list.
2. Account in an error status: critical. Account bounce over 5%: critical. Account bounce over 2%: warning. Warmup under 70: warning. Warmup under 90: opportunity. Paused: opportunity. Each kind is one card, named when a single account is affected and listed when several are.
3. Load: an account that sent 2x+ the median of sending accounts gets an opportunity card, or a warning if it is also over the bounce target.
4. Idle: active accounts with 0 sends while other accounts sent get an opportunity card.

Campaigns (this period)
5. Ranking by reply rate = replied / contacted (contacted = new leads contacted). Only campaigns with 100+ contacted are ranked. The gap card ("rewrite the worse one using the better one's angle") and the "best campaign" win only appear when the best campaign's lower bound beats the worst campaign's upper bound. The worst is picked among campaigns with at least 1 reply. We never call a campaign "best" when only one is eligible.
6. Best positive rate = positive / contacted (positive = opportunities marked in Instantly), using the same guard. The card also shows positive / replied.
7. Compared with his own history (needs CampaignRow.lifetime, and not on the all-time range): the campaign's rate this period vs all OTHER campaigns' lifetime replies pooled (sum replied / sum contacted). It fires only when this period's upper bound is below the pooled lower bound. Severity is warning when the history rate is 2x+ this period's, otherwise opportunity. The detail names his best campaign ever and adds the caveat that a different list may explain part of the gap. When this card fires for a campaign, that campaign gets no "best" win.
8. Stopped winners (needs lifetime, not on all-time): completed or paused campaigns with lifetime replies that sent nothing this period, ranked by lifetime opportunities. Action: relaunch the top one with a fresh list. Severity is warning when 0-1 campaigns are sending, otherwise opportunity.
9. Zero replies: 150+ contacted and exactly 0 replies gives a warning, with a caveat that replies can lag. That campaign is not also compared with history and is not used as the "worst" in the gap card.
10. Campaign in error status: critical. Active with 0 leads remaining: warning. Low runway: an opportunity when leadsRemaining / (contacted / days in range) is under 5 days. Campaigns completed with activity this period: opportunity (not on all-time). When nothing can be ranked, the card says "too early to judge" and lists campaigns under 100 contacted.

Sequence (CampaignRow.steps, steps are 1-based)
11. A/B winner: within one step, compare the best and worst variant that each have 100+ sends, using replied / sent per variant. The card fires only when the two-proportion z >= 1.96. Action: make the winner the default. Both subjects are quoted.
12. Dead follow-up: step 2 or later, 200+ sends across its variants, 0 replies. Action: cut or rewrite the step.
13. Where replies come from: replies per step / all step replies, across campaigns. It needs 20+ replies, and every row must report its replies. When step 1 earns 70% or more: opportunity, "focus on step 1". When follow-ups earn 40% or more: win, "keep the follow-ups".
14. Best subject line: the step/variant with a subject and 100+ sends that has the highest Wilson lower bound. It needs 2+ distinct subjects.

Replies waiting on you (repliedLeads)
15. Leads labeled interested, meeting_booked or meeting_completed with awaitingOurReply = true, oldest first. Days waiting comes from the data layer's daysWaiting, or from generatedAt minus lastReplyAt. 3+ days is critical, 1+ day is a warning, under a day is an opportunity. Each card says "Reply to Dana Lee at Acme, waiting 3 days", plus the snippet. The top 5 get their own cards and the rest roll up into one card.
16. Unlabeled replies still awaiting our reply: one opportunity card, "label them in Unibox".

Trends (this period vs `previous`)
17. Reply rate and positive rate, with 100+ contacted in each period. A card appears only when the two-proportion z >= 1.96. Down is a warning, up is a win. Each card shows both periods, the change in points and the relative change.
18. Volume drop: sent fell 50% or more and the previous period had 200+ sends. Warning.
19. Stalled: 3+ finished days with 0 sends (null days break the streak) after a day that sent. Critical when some campaign is active, warning otherwise.
