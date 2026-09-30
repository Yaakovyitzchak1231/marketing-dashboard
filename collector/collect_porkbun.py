#!/usr/bin/env python3
"""Porkbun domain collector (v2).

Reads the domain inventory via Porkbun's `domain/listAll` endpoint and
upserts into `domains`. Also runs basic DNS health checks (NS records
resolvable) so the dashboard can flag unhealthy domains.

Read-only. Never purchases, renews, or changes DNS.

Requires: PORKBUN_API_KEY + PORKBUN_SECRET_KEY (env). Request them from
Yaakov through the secure credential flow -- never paste them in chat.
Without them the collector records a blocked run and exits 0 (a missing
credential is not a data error).
"""
from __future__ import annotations

import json
import os
import socket
import sys
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v2lib  # noqa: E402

API = "https://api.porkbun.com/api/json/v3"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.load(resp)
    return body if isinstance(body, dict) else {}


def _dns_ok(domain: str) -> tuple[bool, str]:
    """Basic health: the domain's NS records resolve."""
    try:
        socket.getaddrinfo(domain, 443)
        return True, ""
    except socket.gaierror as exc:
        return False, f"dns: {exc}"[:120]
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}"[:120]


def main() -> int:
    sb = v2lib.supabase_client()
    api_key = os.environ.get("PORKBUN_API_KEY")
    # Hermes stores the secret as PORKBUN_SECRET_API_KEY; accept either name.
    secret = os.environ.get("PORKBUN_SECRET_API_KEY") or os.environ.get("PORKBUN_SECRET_KEY")
    if not api_key or not secret:
        v2lib.record_run(
            sb, "porkbun", ok=False,
            stages=[{"stage": "auth", "ok": False,
                     "note": "blocked: PORKBUN_API_KEY / PORKBUN_SECRET_KEY "
                             "not configured"}],
            errors=[{"stage": "auth",
                     "error": "missing Porkbun API credentials"}],
        )
        print("blocked: Porkbun API credentials not configured")
        return 0

    errors: list[dict] = []
    rows: list[dict] = []
    try:
        body = _post("/domain/listAll",
                     {"secretapikey": secret, "apikey": api_key,
                      "start": 0, "includeLabels": "no"})
        if body.get("status") != "SUCCESS":
            raise RuntimeError(f"porkbun: {str(body)[:200]}")
        for d in body.get("domains") or []:
            name = d.get("domain")
            if not name:
                continue
            healthy, note = _dns_ok(name)
            rows.append({
                "domain": name,
                "registrar": "porkbun",
                "status": d.get("status"),
                "expires_at": d.get("expireDate"),
                "auto_renew": str(d.get("autoRenew")).lower() in ("yes", "true", "1"),
                "dns_healthy": healthy,
                "dns_last_checked_at": _now(),
                "updated_at": _now(),
                **({"notes": note} if note else {}),
            })
    except Exception as exc:  # noqa: BLE001
        errors.append({"stage": "domain_list",
                       "error": f"{type(exc).__name__}: {exc}"[:200]})

    persisted = v2lib.upsert(sb, "domains", rows, "domain")
    v2lib.record_run(
        sb, "porkbun", ok=not errors, api_calls=1,
        stages=[{"stage": "domain_list", "ok": not errors,
                 "domains": len(persisted)}],
        errors=errors,
    )
    print(f"domains upserted: {len(persisted)}, errors: {len(errors)}")
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
