#!/usr/bin/env python3
"""Angle metrics sync (v2).

Populates `angle_daily_metrics` from `daily_metrics` via the campaign->angle
mapping in the `angles` table.

Attribution rule (honest, no guessing):
  - A campaign with exactly ONE angle: that angle gets the campaign's full
    daily metrics.
  - A campaign with MULTIPLE angles: metrics cannot be split without
    step-level data (which the Instantly API does not provide -- verified
    2026-09-30). Nothing is written; the campaign is listed as
    "needs manual split" in the run record.
  - A campaign with NO angles: nothing to attribute.

Angles are created by Yaakov in the dashboard UI (name + which campaign).
This script only moves numbers that already exist.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v2lib  # noqa: E402


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


METRIC_COLS = ("emails_sent", "unique_replies", "positive_replies",
               "meetings_booked", "customers_won", "bounces", "cost_usd")


def main() -> int:
    sb = v2lib.supabase_client()
    errors: list[dict] = []

    angles = (sb.table("angles").select("id,campaign_id,name")
              .execute().data or [])
    by_campaign: dict[str, list[dict]] = {}
    for a in angles:
        if a.get("campaign_id"):
            by_campaign.setdefault(a["campaign_id"], []).append(a)

    # Latest metric date per campaign (sync the most recent day available).
    metrics = (sb.table("daily_metrics")
               .select("campaign_id,metric_date," + ",".join(METRIC_COLS))
               .order("metric_date", desc=True).limit(2000).execute().data or [])
    latest: dict[str, dict] = {}
    for m in metrics:
        cid = m.get("campaign_id")
        if cid and cid not in latest:
            latest[cid] = m

    rows: list[dict] = []
    multi: list[str] = []
    for cid, angs in by_campaign.items():
        m = latest.get(cid)
        if not m:
            continue
        if len(angs) == 1:
            rows.append({
                "angle_id": angs[0]["id"],
                "metric_date": m["metric_date"],
                **{c: m.get(c) for c in METRIC_COLS},
            })
        else:
            multi.append(cid)

    persisted = v2lib.upsert(sb, "angle_daily_metrics", rows,
                             "angle_id,metric_date")
    v2lib.record_run(
        sb, "angles",
        ok=not errors,
        stages=[{"stage": "attribute", "ok": True,
                 "angles_synced": len(persisted),
                 "multi_angle_campaigns_unattributed": multi}],
        errors=errors,
    )
    print(f"angle rows upserted: {len(persisted)}, "
          f"multi-angle campaigns skipped: {len(multi)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
