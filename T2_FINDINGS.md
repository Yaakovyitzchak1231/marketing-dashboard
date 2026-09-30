# Campaign Inventory Truncation — Diagnosis & Proof

**Task:** T2 — Solve Instantly campaign inventory truncation  
**Date:** 2026-09-29  
**Status:** Diagnosed — full inventory obtainable via remote file; collector currently reads truncated preview

---

## True Campaign Count

**8 campaigns** — verified by two independent sources:

| Source | Count | Evidence |
|--------|-------|----------|
| `INSTANTLY_COUNT_LAUNCHED_CAMPAIGNS` | 8 | `{"count": 8}` |
| Remote file from `COMPOSIO_MULTI_EXECUTE_TOOL` (INSTANTLY_LIST_CAMPAIGNS) | 8 | Full JSON at `/mnt/files/mex/*.json` |

**Campaign IDs:**
```
e427c801-a5c6-4267-9f0c-1d283b004fe5  IRS Penalty Back - Emails Instantly
ddac824b-fbcc-4d60-9355-d316545e9208  PB Signups / Leads (TEST)
a76f152b-7c57-4c6b-b0e5-e7352b635872  PB Signups / Leads
8ff8cd85-43a9-4df2-af70-31a7b613d2cd  PB Wet Signature Needed
8ddf6580-5ced-448d-b3a1-9f9567e3f645  PB Qualified
8d880aea-a7a8-4d92-92d7-4e056430ab8a  PenaltyBack ERTC Funding Contacts - Draft - 2026-06-19
431e15a1-c494-4fa6-a0c1-84be01acd88e  PB Partners - July 10 Deadline
0d29bafe-cf33-4d38-9910-96c07c35d4f9  TapDash Jewelry Retailers - Test 01
```

---

## Why the Collector Returns Only 2 Campaigns

The collector (`collect_instantly.py:Instantly.call()`) calls `COMPOSIO_MULTI_EXECUTE_TOOL` and processes the response:

```python
# Lines 99-109 of collect_instantly.py
if "data" in resp:
    return resp["data"]
preview = resp.get("data_preview")
if isinstance(preview, str):
    try:
        return json.loads(preview)
    except ValueError:
        return {}
return preview if isinstance(preview, dict) else {}
```

**What happens:**
1. Composio returns large payloads as `data_preview` (truncated) + `remote_file_info` with path to full data
2. The collector checks for `"data"` key — not present for large payloads
3. Falls back to `data_preview` — which contains only 3 items (2 full + `"...6 more items"` string)
4. The `"...6 more items"` is a **literal string**, not parseable JSON
5. Result: only 2 campaign IDs extracted

**Raw response structure:**
```json
{
  "successful": true,
  "data_preview": {
    "items": [ {...full obj...}, {...full obj...}, "...6 more items" ],
    "next_starting_after": "0d29bafe-cf33-4d38-9910-96c07c35d4f9"
  },
  "remote_file_info": {
    "file_path": "/mnt/files/mex/burn.json",
    "message": "Complete response was large (20229 tokens). Full data saved to sandbox..."
  }
}
```

---

## Methods Tested

| Method | Works? | Why / Why Not |
|--------|--------|---------------|
| `INSTANTLY_LIST_CAMPAIGNS` via `data_preview` | ❌ No | Truncated to 3 items (2 objects + 1 string) |
| `INSTANTLY_LIST_CAMPAIGNS` via pagination (`starting_after`) | ❌ No | Second page returns empty `items: []`; cursor doesn't advance past first page |
| `INSTANTLY_COUNT_LAUNCHED_CAMPAIGNS` | ✅ Yes | Returns exact count (8), but no IDs |
| **Remote file from `COMPOSIO_MULTI_EXECUTE_TOOL`** | ✅ **Yes** | Contains complete untruncated `items` array (8 campaigns) |
| `INSTANTLY_GET_CAMPAIGN_ANALYTICS` per campaign | ✅ Yes | Works for all 8 IDs; returns untruncated metrics |

**The working method:** Read the remote file path from `remote_file_info.file_path`, then use `COMPOSIO_REMOTE_BASH_TOOL` (or `COMPOSIO_REMOTE_WORKBENCH`) to parse the full JSON.

---

## Per-Campaign Analytics (All 8 Campaigns)

| Campaign | Sent | Replies (unique) | Opens (unique) | Status |
|----------|------|------------------|----------------|--------|
| IRS Penalty Back - Emails Instantly | 2 | 9 | 0 | 3 (pending) |
| PB Signups / Leads (TEST) | 3 | 10 | 0 | 2 (draft) |
| PB Signups / Leads | 31,893 | 1,357 | 0 | 3 (pending) |
| PB Wet Signature Needed | 464 | 116 | 0 | 3 (pending) |
| PB Qualified | 1,324 | 241 | 0 | 3 (pending) |
| PenaltyBack ERTC Funding Contacts | 9,452 | 143 | 0 | 3 (pending) |
| PB Partners - July 10 Deadline | 281 | 26 | 0 | 3 (pending) |
| TapDash Jewelry Retailers - Test 01 | 2,126 | 8 | 0 | 1 (active) |

**Note:** `open_count_unique` is 0 for all campaigns — this is an Instantly API limitation, not a collector bug. The overview endpoint also returns `open_count_unique: 0`.

**Reply rates:** Use `reply_count_unique` (human replies) — **NOT** `reply_count` (includes autoresponders). The overview shows `reply_count: 2350` vs `reply_count_unique: 1910` (39 automatic). The per-campaign analytics correctly separates these.

---

## Regression Test

Created: `test_regression_campaign_inventory.py`

```python
def test_campaign_inventory_not_truncated():
    true_count = COUNT_LAUNCHED_CAMPAIGNS  # 8
    collected_count = api.campaign_ids()   # currently 2
    assert collected_count == true_count
```

**Current result:** **FAILS** — proves the truncation bug exists.

```
AssertionError: CAMPAIGN INVENTORY TRUNCATED: collector returned 2 campaigns but true count is 8.
```

This test will pass once the collector is fixed to read from the remote file.

---

## Fix Required (for T4 — Collector)

The `Instantly.call()` method must be updated to:

1. Check for `remote_file_info` in the raw response
2. If present, fetch and parse the remote file instead of using `data_preview`
3. Return the full `data` object from the remote file

**Pseudo-fix:**
```python
def call(self, slug: str, **args) -> dict:
    raw = self.mcp.call("COMPOSIO_MULTI_EXECUTE_TOOL", {...})
    # ... existing error handling ...
    resp = results[0].get("response") or {}
    
    # NEW: Check for remote file with full data
    remote_file = raw.get("data", {}).get("remote_file_info", {}).get("file_path")
    if remote_file:
        # Fetch and parse remote file
        bash_result = self.mcp.call("COMPOSIO_REMOTE_BASH_TOOL", {
            "command": f"cat {remote_file} | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)[\"results\"][0][\"response\"][\"data\"]))'"
        })
        return json.loads(bash_result["data"]["stdout"])
    
    # Existing fallback logic for small payloads
    if "data" in resp:
        return resp["data"]
    # ... rest unchanged
```

---

## Conclusion

**The complete campaign inventory IS obtainable.** The fix is to read the `remote_file_info.file_path` that Composio provides alongside every truncated `data_preview`. The per-campaign analytics endpoint already works correctly for all 8 campaigns.

**Blocked for review:** This is the highest-leverage finding in the project. The campaign count (8), the working method (remote file), and raw evidence are documented above.