# A/B experiments (plan 3.6)

An experiment splits the leads reaching one campaign step across variants, counts
sends and positive replies per variant, and can pick the winner on its own once the
numbers are clear. Code: `lib/experiments/` (store, assign, winner, form), the
journey node `lib/journeys/ab-split.ts`, the steps-page panel
`components/campaign-steps/ExperimentsPanel.tsx`, tables in
`db/migrations/0061_ab_experiments.sql`.

## Model

- **One experiment per step.** `unique (campaign_id, step_number)` is intended: the
  node, the steps page and the winner logic all address an experiment by campaign
  and step, and two live experiments on one step would leave "which copy did this
  lead get" without a single answer. To test something new on a step, decide the
  old experiment first.
- **Variant keys** match `^[A-Za-z0-9_-]{1,32}$` (no `:`, no spaces), checked on the
  server and in the dashboard form (which writes variants as `key:weight`).
  A variant key is also the ab_split node's path label, which graph validation
  further requires to start with a letter or digit.
- **Status.** `draft -> running`, `running <-> paused`, `running | paused ->
  decided`. Nothing else: not `running -> draft`, nothing out of `decided`.
  Status changes (start, pause, decide, and the evaluate call, which can decide)
  are owner actions on the dashboard and owner-or-system on the ops door. Name
  edits are editor-level.
- **Config is frozen after draft.** Variants, weights, `auto_winner` and
  `min_sends_per_variant` can only change while the experiment is a draft, because
  once leads are assigned a change would orphan their assignments and outcomes.
- **Hand decision.** `PATCH {status: "decided", winner_variant}` with a configured
  variant key. This is also the way out when `auto_winner` is off or the look
  budget (below) is used up.

## Assignment

A lead is a company, the same identity the campaign lead list uses
(`lp.campaign_leads` is keyed by company; a contact is the person written to). One
company has exactly one assignment per experiment, whichever of its contacts the
run is for: the hash and the unique key are (experiment, company), so it is
deterministic and a retry never flips a lead. Merges are followed (a merged company
or contact resolves to the survivor, and an assignment made under the merged-away
company is honoured). A lead that does not exist is a 404; a do-not-contact or
suppressed lead is not assigned and the answer says why (`assigned: false, reason`).
Assignments are refused while the experiment is a draft or paused. A decided
experiment sends not-yet-assigned leads straight to the winner.

## The ab_split journey node

A plain `NodeHandler` on the journey node registry (`lib/journeys/nodes.ts`, the
only registry): kind `ab_split`, config `{experiment_id, variants: ["A", "B"]}`.
`variants` lists the experiment's variant keys; the node needs one path per variant
labelled with the key, and no `next`. Graph validation checks those paths against
`variants` (it cannot see the database); at run time the node also checks the
experiment's real variants and fails the run loudly if one has no path.

At run time the node assigns the lead and takes the path named after the variant,
recording `ab_<node id>: {experiment_id, variant}` in the run context. After a
decision every lead takes the winner's path. While the experiment is a draft or
paused the run waits on the node and re-checks every 15 minutes (it does not error);
a suppressed or do-not-contact lead leaves the journey.

## Outcomes

`POST /experiments/:id/outcome {variant, sends?, positive_replies?, idempotency_key?}`
(owner only). `positive_replies` counts **positive replies only**: auto-replies,
unsubscribes and negative replies are not wins and must never be posted (the winner
logic treats every counted reply as a win). The same name is used in the database
column, the activity log and the dashboard.

- The variant must be configured on the experiment and the experiment must be
  running; otherwise 400 / 409.
- `sends` and `positive_replies` are whole numbers >= 0 (anything else is a 400, not
  a NaN). A replies-only delta is fine; the rule `positive_replies <= sends` is a
  database constraint on the cumulative counters, and a violation is a 400.
- `idempotency_key` is claimed with one atomic insert into
  `lp.experiment_outcome_keys` (primary key experiment, variant, key) in the same
  transaction as the counter update, so concurrent retries apply once. A replay
  answers `replayed: true` with the current counters.

## Auto-winner

Rates are positive replies / sends from raw counts, never an average of rates. The
test is the insights engine's pooled two-proportion z (`lib/insights/stats.ts`),
with these controls (`lib/experiments/winner.ts`):

1. **Minimum sample on every variant.** Every configured variant needs
   `min_sends_per_variant` sends (default 100) before any decision; a variant with
   no outcome yet counts as 0 sends and blocks it.
2. **Best against every other.** The variant with the highest rate is compared with
   each other variant and must beat all of them (not just the worst).
3. **Bonferroni across comparisons.** With k variants each test runs at
   alpha / (k - 1), alpha = 0.05 two-sided (two variants: the usual z >= 1.96).
4. **Peeking control.** Evaluating over and over inflates false winners. A look is
   only taken when the smallest variant reaches min, 2 x min, 4 x min, ... sends,
   at most 5 looks (`lp.experiments.evaluated_looks`), and each test is also
   corrected for those 5 looks: alpha_test = 0.05 / (5 x (k - 1)). Evaluating again
   before the next milestone tests nothing. After the last look the auto-winner
   stops and the owner decides by hand. This is a conservative Bonferroni guard,
   not an exact sequential test; it gives up power to keep false winners rare.

The decide step is `update ... where status = 'running' returning id`: if the
experiment was paused or decided concurrently nothing changes, nothing is logged,
and the result says it was not decided.
