#!/usr/bin/env python3
"""InboxKit mailbox collector (v2).

Lists mailboxes via POST /v1/api/mailboxes/list and upserts health state
into `inboxes` (domain, email_address, health_status, warmup state).

Read-only inventory/health. Never purchases mailboxes or changes settings.

Requires: INBOXKIT_API_KEY (+ INBOXKIT_WORKSPACE_ID). Without them the
collector records a blocked run and exits 0.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v2lib  # noqa: E402

API = "https://api.inboxkit.com/v1"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _post(path: str, payload: dict, key: str, workspace: str | None) -> dict:
    headers = {"Content-Type": "application/json",
               "Authorization": f"Bearer {key}"}
    if workspace:
        headers["X-Workspace-Id"] = workspace
    req = urllib.request.Request(
        API + path, data=json.dumps(payload).encode(),
        headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.load(resp)
    return body if isinstance(body, dict) else {}


def main() -> int:
    sb = v2lib.supabase_client()
    key = os.environ.get("INBOXKIT_API_KEY")
    workspace = os.environ.get("INBOXKIT_WORKSPACE_ID")
    if not key:
        v2lib.record_run(
            sb, "inboxkit", ok=False,
            stages=[{"stage": "auth", "ok": False,
                     "note": "blocked: INBOXKIT_API_KEY not configured "
                              "(Dashboard -> Settings -> API & Integrations)"}],
            errors=[{"stage": "auth",
                     "error": "missing InboxKit API key"}],
        )
        print("blocked: InboxKit API key not configured")
        return 0
    if not workspace:
        v2lib.record_run(
            sb, "inboxkit", ok=False,
            stages=[{"stage": "auth", "ok": False,
                     "note": "blocked: INBOXKIT_WORKSPACE_ID not set; "
                              "collector cannot list mailboxes without it"}],
            errors=[{"stage": "auth",
                     "error": "missing INBOXKIT_WORKSPACE_ID"}],
        )
        print("blocked: INBOXKIT_WORKSPACE_ID not set; "
              "collector cannot list mailboxes without it")
        return 0
    errors: list[dict] = []
    rows: list[dict] = []
    try:
        body = _post("/api/mailboxes/list", {}, key, workspace)
        items = body.get("mailboxes") or body.get("data") or body.get("items") or []
        if not items and body:
            # Surface the unexpected shape instead of silently writing nothing.
            errors.append({"stage": "mailbox_list",
                           "error": f"unexpected response shape: "
                                    f"{str(body)[:160]}"})
        for m in items:
            email = m.get("email") or m.get("address") or m.get("username")
            if not email:
                continue
            domain = email.split("@")[-1] if "@" in email else None
            health = (m.get("health_status") or m.get("status") or "").lower()
            rows.append({
                "domain": domain,
                "email_address": email,
                "provider": "inboxkit",
                "health_status": health or None,
                "warmup_enabled": bool(m.get("warmup_enabled", m.get("warmup"))),
                "warmup_score": m.get("warmup_score") or m.get("health_score"),
                "last_seen_at": _now(),
                "updated_at": _now(),
            })
    except Exception as exc:  # noqa: BLE001
        errors.append({"stage": "mailbox_list",
                       "error": f"{type(exc).__name__}: {exc}"[:200]})
    persisted = v2lib.upsert(sb, "inboxes", rows, "email_address")
    v2lib.record_run(
        sb, "inboxkit", ok=not errors, api_calls=1,
        stages=[{"stage": "mailbox_list", "ok": not errors,
                 "inboxes": len(persisted)}],
        errors=errors,
    )
    print(f"inboxes upserted: {len(persisted)}, errors: {len(errors)}")
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
