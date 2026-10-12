Only arm auto-merge when every rule below holds. If any rule cannot be confirmed, do not arm.

1. The PR targets main. Never arm on a PR whose base is another branch.
2. Stacked PRs (built on another open PR's branch) wait. Only arm once the PR they were built on has merged and this PR has been retargeted to main.
3. The PR is not a draft and has no merge conflicts with main.
4. The CI job named "check" has passed on the latest head commit. Never arm while it is pending, failing or skipped.
5. No unresolved must-fix, blocking or security review comments, from Gitar, Instinct or Gemini (gemini-code-assist). Every review thread is resolved.
6. Database migrations are add-only. Migrations auto-apply on the production deploy, so:
   - Never arm on a PR that edits, renames or deletes an existing file in supabase/migrations or db/migrations.
   - A new migration file must use a number that no migration already on main uses in either folder.
   - A PR that drops or renames a table or column, or deletes data, is high risk: never arm.
7. Only merge changes Gitar rates low or medium risk. Never arm on high-risk changes.
8. Never arm on a PR that edits .gitar/, .github/workflows/, vercel.json, middleware.ts or anything that handles secrets or auth, without a human merge.
9. Merge method: squash.
