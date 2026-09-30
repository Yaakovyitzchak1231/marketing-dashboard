#!/usr/bin/env python3
"""Live restore driver: collect from Instantly, then upsert into Supabase.

collect_instantly.py's main() only writes the local JSON files -- it never
calls persist(), so running the script against an empty database restores
nothing. This driver is the missing path: collect() -> rollup() -> persist().

Usage:
    set -a; . <env with SUPABASE_SERVICE_ROLE_KEY>; set +a
    python3 restore_live.py
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import collect_instantly as ci  # noqa: E402


def main() -> int:
    got = ci.collect()
    errors = got["errors"]
    totals = ci.rollup(got["overview"], got["campaigns"], got["senders"])

    print("=== COLLECTED ===")
    print(json.dumps({
        "campaigns": totals["campaigns_total"],
        "active": totals["campaigns_active"],
        "emails_sent": totals["emails_sent"],
        "replies_human": totals["replies"],
        "replies_all": totals["replies_all"],
        "bounces": totals["bounced"],
        "opportunities": totals["opportunities"],
        "opportunity_value": totals["opportunity_value"],
        "senders": totals["fleet_total"],
        "api_calls": got["calls"],
        "errors": len(errors),
    }, indent=2))
    for e in errors:
        print(f"  ! {e['stage']}: {e['error'][:160]}", file=sys.stderr)

    if totals["emails_sent"] is None:
        print("REFUSING to persist: the overview call returned no emails_sent.",
              file=sys.stderr)
        return 1

    sb = ci.supabase_client()
    result = ci.persist(sb, got)
    print("=== PERSISTED ===")
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
