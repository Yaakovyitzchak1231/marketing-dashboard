#!/usr/bin/env python3
"""Angle metrics sync (v2)."""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v2lib  # noqa: E402

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

def main() -> int:
    sb = v2lib.supabase_client()

    angles = (sb.table("angles")
              .select("id,campaign_id,name")
              .execute().data or [])

    by_campaign: dict[str, list[dict]] = {}
    for a in angles:
        if a.get("campaign_id"):
            by_campaign.setdefault(a["campaign_id"], []).append(a)

    # Latest metric date per campaign (sync the most recent day available).
    # Only read columns that actually exist in the live daily_metrics table.
    # Missing from live schema: unique_replies, positive_replies,
    # meetings_booked, customers_won -- these are not available.
    # We read: emails_sent, replies_human, replies_autoresponder, bounces, cost_usd
    metrics = (sb.table("daily_metrics")
               .select("campaign_id,metric_date,emails_sent,replies_human,replies_autoresponder,bounces,cost_usd")
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
            # Map available daily_metrics columns to angle_daily_metrics.
            # - emails_sent (daily_metrics) -> sent (angle_daily_metrics), same metric
            # - replies_human -> replies_human, same name
            # - replies_autoresponder -> replies_autoresponder, same name
            # - bounces and cost_usd have no target column in angle_daily_metrics;
            #   they are omitted from this upsert.
            # - positive_replies: daily_metrics has no such column; we write NULL
            #   and note it as a known gap in the summary.
            rows.append({
                "angle_id": angs[0]["id"],
                "metric_date": m["metric_date"],
                "sent": m.get("emails_sent"),
                "replies_human": m.get("replies_human"),
                "replies_autoresponder": m.get("replies_autoresponder"),
                "positive_replies": None,  # not collected by daily_metrics
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