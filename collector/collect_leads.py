#!/usr/bin/env python3
"""Lead-level collector for the marketing dashboard (v2).

Pulls every lead in every Instantly campaign (INSTANTLY_LIST_LEADS, paged on
the `campaign` param) and upserts them into the `leads` table keyed on email.

Design rules, in priority order:
  1. Never invent a number. A failed campaign pull becomes an entry in
     `errors`, never a zero. Zero is a real measurement; null is "the API
     did not say".
  2. The lead-pull NEVER overwrites verification columns (zb_*, mv_*).
     Those belong to the verification collectors. Existing values are read
     back and merged into the upsert.
  3. reply_sentiment is set to 'positive' only when Instantly marks the lead
     interested (lt_interest_status == 1, verified against live data
     2026-09-30: correlates with replies + interest-change timestamps).
     Anything else stays NULL -- we do not guess the rest of the enum.
"""
from __future__ import annotations

import os
import json
import shlex
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v2lib  # noqa: E402

PAGE_LIMIT = 50  # Composio guidance: large pages balloon; stay conservative.
ACCOUNT = "instantly_moline-parsec"
VERIF_COLS = ("zb_status", "zb_substatus", "zb_verified_at",
              "mv_result", "mv_subresult", "mv_verified_at")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _err(stage: str, exc: Exception) -> dict:
    return {"stage": stage, "error": f"{type(exc).__name__}: {exc}", "at": _now()}


def _read_remote_file(mcp, path: str) -> dict:
    """Read a remote file offloaded by Composio, unwrapping to the inline data."""
    out = mcp.call("COMPOSIO_REMOTE_BASH_TOOL", {
        "command": (
            "cat " + shlex.quote(path) + " 2>/dev/null | head -c 20000000"
        )
    })
    stdout = (out.get("data") or {}).get("stdout")
    if not stdout:
        raise RuntimeError(
            f"remote file {path} returned no stdout "
            f"(error={str(out.get('error'))[:200]})"
        )
    try:
        envelope = json.loads(stdout)
    except ValueError as exc:
        raise RuntimeError(f"remote file {path} is not valid JSON: {exc}") from exc
    # Unwrap the same shapes an inline response can take.
    node = envelope
    for key in ("results", "response", "data"):
        if isinstance(node, dict) and key in node:
            node = node[key]
    if not isinstance(node, dict):
        raise RuntimeError(f"remote file {path}: unexpected envelope shape")
    if "data" in node and isinstance(node["data"], dict):
        return node["data"]
    return node


def _mcp_call(mcp, slug: str, **args) -> dict:
    raw = mcp.call("COMPOSIO_MULTI_EXECUTE_TOOL",
                   {"tools": [{"tool_slug": slug,
                               "arguments": {"account": ACCOUNT, **args}}]})
    if not raw.get("successful"):
        raise RuntimeError(f"{slug}: {raw.get('error')}")
    results = (raw.get("data") or {}).get("results") or []
    if not results:
        raise RuntimeError(f"{slug}: empty results")
    resp = results[0].get("response") or {}
    if not resp.get("successful", True):
        raise RuntimeError(f"{slug}: {str(resp)[:200]}")
    remote = (raw.get("data") or {}).get("remote_file_info") or {}
    remote_path = remote.get("file_path")
    if remote_path:
        return _read_remote_file(mcp, remote_path)
    data = resp.get("data")
    if isinstance(data, dict):
        return data
    preview = resp.get("data_preview")
    if isinstance(preview, str):
        try:
            return json.loads(preview)
        except ValueError:
            return {}
    return preview if isinstance(preview, dict) else {}


def _lead_row(item: dict, campaign_uuid: str | None, campaign_name: str) -> dict | None:
    email = (item.get("email") or "").strip()
    if not email:
        return None
    payload = item.get("payload") or {}
    return {
        "email": email,
        "first_name": payload.get("firstName") or item.get("first_name"),
        "company": item.get("company_name"),
        "source": "instantly",
        "source_detail": campaign_name,
        "first_contacted_at": item.get("timestamp_created"),
        "first_campaign_id": campaign_uuid,
        "replied_at": item.get("timestamp_last_reply"),
        "reply_sentiment": "positive" if item.get("lt_interest_status") == 1 else None,
        "updated_at": _now(),
    }


def _merge_verification(sb, rows: list[dict]) -> list[dict]:
    """Re-attach existing verification columns so the upsert can't clobber them."""
    emails = [r["email"] for r in rows]
    existing: dict[str, dict] = {}
    for i in range(0, len(emails), 200):
        chunk = emails[i:i + 200]
        res = (sb.table("leads")
               .select("email," + ",".join(VERIF_COLS))
               .in_("email", chunk)
               .execute())
        for r in res.data or []:
            existing[(r.get("email") or "").lower()] = r
    for r in rows:
        prev = existing.get(r["email"].lower())
        if prev:
            for c in VERIF_COLS:
                r[c] = prev.get(c)
    return rows


def collect(mcp, sb) -> dict:
    errors: list[dict] = []
    all_rows: list[dict] = []
    campaigns_seen = 0
    calls = 0

    def call(slug: str, **args) -> dict:
        nonlocal calls
        calls += 1
        return _mcp_call(mcp, slug, **args)

    try:
        res = sb.table("campaigns").select("id,external_id,name").execute()
        campaigns = res.data or []
    except Exception as exc:  # noqa: BLE001
        errors.append(_err("campaign_identity", exc))
        campaigns = []

    if not campaigns:
        try:
            listed = call("INSTANTLY_LIST_CAMPAIGNS", limit=100)
            items = listed.get("items") or listed.get("campaigns") or []
            campaigns = [{"id": None, "external_id": c.get("id"),
                          "name": c.get("name")} for c in items if c.get("id")]
        except Exception as exc:  # noqa: BLE001
            errors.append(_err("campaign_list", exc))

    for camp in campaigns:
        ext_id = camp.get("external_id")
        if not ext_id:
            continue
        campaigns_seen += 1
        cursor = None
        try:
            while True:
                args: dict = {"campaign": ext_id, "limit": PAGE_LIMIT}
                if cursor:
                    args["starting_after"] = cursor
                data = call("INSTANTLY_LIST_LEADS", **args)
                items = data.get("items") or []
                for it in items:
                    row = _lead_row(it, camp.get("id"), camp.get("name") or ext_id)
                    if row:
                        all_rows.append(row)
                cursor = data.get("next_starting_after")
                if not cursor or not items:
                    break
        except Exception as exc:  # noqa: BLE001
            errors.append(_err(f"leads:{ext_id[:8]}", exc))

    return {"rows": all_rows, "errors": errors,
            "campaigns": campaigns_seen, "calls": calls}


def persist(sb, collected: dict) -> dict:
    rows = _merge_verification(sb, collected["rows"])
    seen: dict[str, dict] = {}
    for r in rows:
        seen[r["email"].lower()] = r
    deduped = list(seen.values())
    persisted = v2lib.upsert(sb, "leads", deduped, "email")
    v2lib.record_run(
        sb, "leads",
        ok=not collected["errors"],
        api_calls=collected["calls"],
        stages=[{"stage": "lead_pull", "ok": not collected["errors"],
                 "leads": len(deduped), "campaigns": collected["campaigns"]}],
        errors=collected["errors"],
    )
    return {"leads": len(persisted), "errors": len(collected["errors"])}


def main() -> int:
    mcp = v2lib.composio_mcp()
    sb = v2lib.supabase_client()
    collected = collect(mcp, sb)
    try:
        result = persist(sb, collected)
    except Exception as exc:  # noqa: BLE001
        print(f"persist failed: {exc}", file=sys.stderr)
        return 1
    print(f"leads upserted: {result['leads']}, "
          f"campaigns: {collected['campaigns']}, "
          f"errors: {result['errors']}, api_calls: {collected['calls']}")
    for e in collected["errors"][:6]:
        print(f"  ! {e['stage']}: {e['error'][:110]}", file=sys.stderr)
    return 0 if not collected["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
