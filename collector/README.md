# Collector

Ported from the working prototype at
`/home/hermes/.hermes/profiles/mkt-data/workspace/marketing-dashboard/`.

Runs on the OVH VM (not Vercel — the hobby plan has no useful cron for this)
and upserts into Supabase. That upsert work is card T4.

## The truncation fix (T2)

`Instantly.call()` previously read `data_preview` when the inline `data` key
was absent. For large responses Composio returns a truncated preview whose
`items` array ends with the **literal string** `"...N more items"` — so the
collector silently kept 2 of 8 campaigns.

The fix resolves `remote_file_info.file_path` through
`COMPOSIO_REMOTE_BASH_TOOL` before ever touching the preview.

**On failure it raises; it never falls back to the preview.** A short list that
looks complete is worse than a loud failure, because every rate computed from
it is wrong.

## Verification

```bash
# unit — no network, pins the contract
python test_remote_file_fallback.py

# integration — compares campaign_ids() against the authoritative count
python test_regression_campaign_inventory.py
```

Both pass as of commit 3766558. The integration test is the real guard: it fails
the moment the collector returns anything other than 8.

## Known API limitations (not collector bugs)

- `open_count_unique` is `0` for every campaign, and the overview agrees. The
  Instantly API does not populate it. **Render open rate as unavailable — never
  `0.0%`.**
- Pagination via `starting_after` does not work: the second page comes back
  empty and the cursor does not advance. The remote file is the only complete
  path.
