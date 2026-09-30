#!/usr/bin/env python3
"""v2 collector orchestrator.

Runs the collector suite in dependency order:
  1. collect_leads      (Instantly -> leads)
  2. collect_zerobounce (leads -> zb_* columns)
  3. sync_angles        (daily_metrics -> angle_daily_metrics)
  4. collect_porkbun    (domains; blocked until API keys exist)
  5. collect_inboxkit   (inboxes; blocked until API key exists)

Each collector records its own collection_runs row. A failing collector
does not stop the rest -- failures are rows, not crashes.

Environment:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or vault custom.supabase)
  PORKBUN_API_KEY / PORKBUN_SECRET_KEY (optional until provided)
  INBOXKIT_API_KEY / INBOXKIT_WORKSPACE_ID (optional until provided)

Instantly and ZeroBounce authenticate via the Hatch vault surrogates
(custom.composio, custom.zerobounce); nothing secret touches disk.
"""
from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

COLLECTORS = [
    "collect_leads.py",
    "collect_zerobounce.py",
    "sync_angles.py",
    "collect_porkbun.py",
    "collect_inboxkit.py",
]


def main() -> int:
    failures: list[str] = []
    for name in COLLECTORS:
        path = os.path.join(HERE, name)
        print(f"--- {name} ---", flush=True)
        proc = subprocess.run(
            [sys.executable, path],
            capture_output=True, text=True, timeout=1800,
        )
        sys.stdout.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        if proc.returncode != 0:
            failures.append(name)
            print(f"!! {name} exited {proc.returncode}", flush=True)
    if failures:
        print(f"failed: {', '.join(failures)}")
        return 1
    print("all collectors ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
