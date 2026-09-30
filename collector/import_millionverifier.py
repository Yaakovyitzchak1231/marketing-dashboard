#!/usr/bin/env python3
"""MillionVerifier result importer (v2).

MillionVerifier's API is IP-blocked from our infrastructure (Cloudflare
1010 from both the Hatch VM and the OVH box, verified 2026-09-30), so
there is no live MV collector. Instead this imports a CSV exported from
the MillionVerifier dashboard after Yaakov runs a batch himself.

Usage:
    python3 import_millionverifier.py --csv mv_results.csv --list-name "jewelry-restock"

Expected CSV columns (MillionVerifier export): email, result, subresult
(or: Email, Result, Subresult -- headers are matched case-insensitively).
Writes mv_result / mv_subresult / mv_verified_at on `leads` and a
`verification_runs` row. Never touches the zb_* columns.
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v2lib  # noqa: E402


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--list-name", default="manual-import")
    args = ap.parse_args()

    sb = v2lib.supabase_client()
    rows: list[dict] = []
    with open(args.csv, newline="") as fh:
        reader = csv.DictReader(fh)
        cols = {c.lower(): c for c in (reader.fieldnames or [])}
        email_c = cols.get("email")
        result_c = cols.get("result")
        sub_c = cols.get("subresult") or cols.get("sub_result")
        if not email_c or not result_c:
            print(f"csv needs email + result columns; found: {reader.fieldnames}",
                  file=sys.stderr)
            return 1
        for line in reader:
            email = (line.get(email_c) or "").strip()
            if not email:
                continue
            rows.append({
                "email": email,
                "mv_result": (line.get(result_c) or "").strip().lower() or None,
                "mv_subresult": (line.get(sub_c) or "").strip()[:120] if sub_c else None,
                "mv_verified_at": _now(),
                "updated_at": _now(),
            })

    if rows:
        emails = [r["email"] for r in rows]
        existing: dict[str, dict] = {}
        for i in range(0, len(emails), 200):
            chunk = emails[i:i + 200]
            got = sb.table("leads").select("*").in_("email", chunk).execute()
            for g in got.data or []:
                existing[(g.get("email") or "").lower()] = g
        merged = []
        for r in rows:
            base = existing.get(r["email"].lower()) or {"email": r["email"]}
            base.update(r)
            merged.append(base)
        v2lib.upsert(sb, "leads", merged, "email")

    from collections import Counter
    counts = Counter(r["mv_result"] for r in rows)
    sb.table("verification_runs").insert({
        "provider": "millionverifier",
        "list_name": args.list_name,
        "ran_at": _now(),
        "total": len(rows),
        "valid": counts.get("ok", 0) + counts.get("valid", 0),
        "invalid": counts.get("invalid", 0),
        "catch_all": counts.get("catch-all", 0) + counts.get("catchall", 0),
        "do_not_mail": counts.get("do_not_mail", 0),
        "unknown": counts.get("unknown", 0),
        "credits_used": 0,
    }).execute()

    v2lib.record_run(
        sb, "millionverifier", ok=True,
        stages=[{"stage": "csv_import", "ok": True,
                 "imported": len(rows), "file": args.csv}],
    )
    print(f"imported {len(rows)} MillionVerifier results")
    return 0


if __name__ == "__main__":
    sys.exit(main())
