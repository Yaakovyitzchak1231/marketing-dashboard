# Platform follow-up safety fixes

Date: 2026-10-09. Originally prepared on `fix/platform-followup-safety`, based on the local notification-reliability commit `8507859`; continued with citation work on `feat/seo-citation-actions`. This is source/test work, not a production deployment.

## SEO measurement integrity

- Empty answers and explicit provider refusal/safety markers remain unknown, not measured negatives.
- Run counts are calculated from stored result rows. A result-storage failure is not mislabeled as a provider failure.
- The overview, detailed results and action feedback use answered counts, with errors and unanswered responses shown separately. Running is not displayed as failed; missing historical data stays unavailable.
- Migration 0017 repairs historical empty-text verdicts from stored evidence and recomputes counts. Historical web-search/brand/prompt configuration remains NULL because it cannot be reconstructed safely. New runs store that configuration.
- Removed provider cost projections without a named source. These are sampled API answers, not consumer chatbot rankings or market-share measurements.

## WordPress mutation journal

Migration 0018 adds prepared/uncertain/undo states and persistent resource reservations. Before sending a WordPress mutation, the server commits the target and intended before/after values. If the network response or database settlement is lost, that record survives and blocks blind replay. Draft requests with a previously confirmed identical input return the existing change instead of creating another draft. Exact-path matching replaces the unsafe single-slug fallback.

Confirmed success requires an API read-back. That is not verification of the public rendered page, SEO indexing, or a browser view. Undo is reserved and tracked too; uncertain outcomes are not presented as successful changes.

### Handling an uncertain WordPress outcome

1. Do not retry the action or delete its journal row.
2. Have an operator inspect the stored change ID, site, WordPress ID if known, before/after values and the actual WordPress state.
3. Confirm the original request is no longer in flight. Reconcile the journal only with evidence of the effect; keep the reservation if the outcome cannot be established.
4. A draft-create response lost before its ID is recorded needs manual identification. Do not assume a page with the same slug is the one this operation created.

The WordPress REST API is not a cross-database transaction. Dashboard reservations prevent competing dashboard writes, but cannot prevent an external WordPress admin from editing between the live-value check and mutation. Stronger atomic revision checks/idempotency need a WordPress-side adapter/plugin. No plugin was installed or site changed here.

## Task safety

- Task mutation checks actor, status, unexpired database-clock lease and claim attempt while holding the task row lock.
- Clients retain `attempts` returned by `claim_task` and pass it as `claim_attempt` on heartbeat, completion, failure and handoff. An omitted attempt is accepted only on the first claim for legacy compatibility; it is refused after retry/reclaim.
- The direct engine path checks pause/claim state at checkpoints and before writes. An old process with the same actor cannot write a newer attempt's work.
- Research results and task completion share one transaction, so a failed completion cannot leave research writes committed separately.
- Agents cannot use human manual task edits to bypass claim checks. Internal SEO re-audit reconciliation only closes still-unclaimed fixes.

Pauses are cooperative; already-sent external requests cannot be undone. Multi-connection PostgreSQL race/load tests remain a release gate; PGlite tests do not establish production concurrency behavior.

## Notification context

Migration 0019 carries pinned-comment IDs and informational-reply markers through the stored notification and feed. Mention events carry full comment text. Clients must not start automatic reply runs for `auto_reply: true`; automatic results use `send_message` with `no_reply: true`. The Hermes relay now answers pinned comments on their thread, preserves verified human mentions while defusing agent mentions (including in completion reports), and sends one informational reply to an allowed agent DM.

Relay starts persist the returned claim before calling Hermes, reuse it after a busy response, and independently retry pending work rather than waiting for another feed ping. Every task start/restart/poll verifies its claim. Temporary heartbeat failures defer work; stale/paused claims stop relay work. In-process drains/checks are serialized. Interrupted/404 runs retain state until restart succeeds or a bounded failure is reported. Failed stop reports are retried without restarting work.

Limits: one relay process per state file; remote claim and local persistence are not atomic; a lost claim response can require reconciliation. Stopping the relay does not cancel an already-running Hermes request. Notification-response posting is at-least-once and may duplicate after a lost acknowledgement. The last 1,000 completed events are deduplicated locally; this is not unlimited exactly-once delivery.

## Rollout boundaries

- No external dependencies or dependency-version changes.
- No production data writes, provider calls, WordPress mutations, relay installation, push, PR or deployment performed.
- Coordinate server, engine and relay rollout. Old clients do not understand the reply/claim-attempt contract. Apply additive migrations through the normal reviewed deployment; keep preview databases isolated.
- Unattended delivery still requires operator-configured transport and an independent retry schedule. Neither configuration nor live delivery is implied by passing local tests.

## Validation

Safety-pass checks before the citation follow-up (all exit code 0):

- `npm run check`: TypeScript, ESLint and 80 test files / 975 tests passed.
- `npm run lint:strict`: zero warnings.
- `npm run build`: production build passed (not a deployment).
- `node --check ops/hermes-relay/lib.mjs`: syntax passed.
- Node 22 stripped-TypeScript import of the engine: `runWorkerDb`, `runWorkerApi`, `workTaskDb` are exported functions.
- `git diff --check`: passed.

The relay has 31 focused regressions, plus three tests that run its requests against the actual ops dispatcher and isolated database: claim/ack/completion with human-only mentions, pinned-comment reply routing, and a single informational agent DM reply without a reply loop. Those integration tests found and verified the missing `list_actors` operation; it returns only active actor IDs, kinds and display names.

Tests use isolated databases, fake provider/WordPress/Hermes responses, and rendered DOM assertions. No live provider receipt, production browser test, public rendered-page verification, or real multi-connection database race is claimed. Before production, run staging integration and multi-connection concurrency tests, verify transports/credentials and scheduler configuration, then obtain approval for the coordinated release.

## Citation follow-up and resumed validation

The citation work adds migration 0020 and `/seo/citations`: stored mention/citation/retrieval evidence, per-run site snapshots, comparable-run history, and human-queued content review or WordPress draft tasks. See `docs/seo.md` for the evidence contract and limits. Older mixed-source arrays stay unclassified. No live changes are made by queuing a task.

An intermittent comment UI test exposed a real late-autosave race rather than merely a slow test. Controlled-timer tests reproduced queued saves running after send and an earlier request restoring local storage after send. The fix guards sent/discarded draft IDs before a save and after its response, cancels pending draft timers on send, and displays the successful send receipt even when the following refresh is offline. Regression tests also cover partial-send retry and discard with an in-flight save.

Latest integrated validation (all exit code 0):

- `npm run check`: TypeScript, ESLint and 83 test files / 1,008 tests passed.
- `npm run lint:strict`: zero warnings.
- `npm run build`: production build passed, including `/seo/citations`.
- `node --check ops/hermes-relay/lib.mjs` and `git diff --check`: passed.

These are local checks, not a release. Production migrations, live transports, paid provider sampling and end-to-end staging/production verification have not been performed by this follow-up.
