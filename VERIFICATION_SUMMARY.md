# Review: TapDash collaboration surface

## What is done
- Data layer committed and verified (migration `006_revision_history.sql`; `lib/revisions.ts` helpers; `npm test` = 236 passing; `tsc --noEmit` green; pushed to origin `task/revision-history`, commit `a4815bf`).

## What is written but not yet verified on the live target
- `lib/copy.ts` — `COPY.workspace.*` block attached (committed on `task/collab-copy`, `df3fab4c`).
- `components/artifact-provenance.tsx` — provenance panel (ownership, revision timeline, approval chips, row comments, boundary badge).
- `app/ideas/page.tsx`, `app/costs/page.tsx`, `app/angles/page.tsx` — each wires `<ArtifactProvenance>` at the bottom of the live artifact.
- New API routes: `app/api/revisions/route.ts`, `app/api/approvals/route.ts`, `app/api/comments/route.ts`, `app/api/checkpoints/route.ts`, `app/api/checkpoints/restore/route.ts`.
- New migration `supabase/migrations/007_collaboration_store.sql` — `approvals`, `comments`, `checkpoints` tables with the single-owner `yaakovytroutai@gmail.com` gate, no anon policy, no public scope.

## Verification so far (repo-local, exact output)
- `./node_modules/.bin/tsc --noEmit` → exit 0 (no errors).
- `./node_modules/.bin/vitest run` → 19 test files, 237 tests passed, exit 0.
- `./node_modules/.bin/next build` → exit 0; routes for `/api/revisions`, `/api/approvals`, `/api/comments`, `/api/checkpoints`, `/api/checkpoints/restore` all compile into the production build.

## What is NOT yet verified on the live target
- `lib/copy.ts`, `components/artifact-provenance.tsx`, the three pages, the new API routes, and migration `007` are NOT in the live Vercel build (deployment `dpl_JCfiAxYdYbS6pLR35CgStpzQQUg3`, alias `https://marketing-dashboard-xi-five.vercel.app`) and NOT applied to the live DB. The live DB still reports `approvals`, `comments`, `checkpoints` as absent and the collaboration UI pages as `/login`.
- The live QA card (t_60c2ad72) stays OPEN until re-verification against the live target returns PASS for history attribution, approval state, restore/pin, and dashboard honesty.

## To finish
1. Apply migration `007` to the live Supabase project (`zlbxjdueuhinywnovyoe`).
2. Deploy the commit(s) that land `lib/copy.ts` + `artifact-provenance.tsx` + the three pages + the new API routes to the live Vercel build.
3. Re-run the live QA against `https://marketing-dashboard-xi-five.vercel.app` and report exactly what the live target says, with PASS/FAIL per check.
