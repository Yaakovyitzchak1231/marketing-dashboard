#!/usr/bin/env python3
"""ZeroBounce verification collector (v2).

Validates leads that have no zb_status yet, using the single-validate API
(v2/validate -- the batch endpoint rejects this account's key). Writes
results to `leads` and records a `verification_runs` row.

Standing rule: role addresses (support@, info@, ...) are NEVER sent to the
verifier. They are marked do_not_mail/role_address locally without spending
a credit.

Credit discipline: the collector checks the balance first and validates at
most (credits - reserve). A shortfall is reported, not failed -- partial
progress is honest progress.
"""
from __future__ import annotations

import os
import sys
import urllib.parse
import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
import v2lib  # noqa: E402

try:
    from dynamic_credentials import (  # noqa: E402
        url_with_surrogate_query_param,
        read_json_response,
        ensure_allowed_url,
    )
    _VAULT = True
except ImportError:
    _VAULT = False

    def read_json_response(resp):  # noqa: E306
        return json.load(resp)

HOSTS = ["api.zerobounce.net"]
CREDENTIAL = "custom.zerobounce"
WORKERS = 10
BATCH = 500          # max leads per run
CREDIT_RESERVE = 50  # never drain the account to zero

ROLE_PREFIXES = ("support@", "hello@", "contact@", "info@", "sales@",
                 "admin@", "help@", "team@", "office@", "mail@")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get(path: str, params: dict) -> dict:
    """GET against the ZeroBounce API. Key via vault surrogate or env."""
    key = os.environ.get("ZEROBOUNCE_API_KEY")
    if key:
        url = (f"https://api.zerobounce.net{path}?"
               f"api_key={urllib.parse.quote(key)}&"
               f"{urllib.parse.urlencode(params)}")
    else:
        if not _VAULT:
            raise RuntimeError(
                "no ZeroBounce API key (env ZEROBOUNCE_API_KEY or vault)")
        base = url_with_surrogate_query_param(
            f"https://api.zerobounce.net{path}",
            CREDENTIAL, allowed_hosts=HOSTS)
        url = base + "&" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=45) as resp:
        body = read_json_response(resp)
    return body if isinstance(body, dict) else {}


def _credits() -> int:
    body = _get("/v2/getcredits", {})
    try:
        return int(str(body.get("Credits", "0")).replace(",", ""))
    except ValueError:
        return 0


def _validate_one(email: str) -> dict:
    try:
        body = _get("/v2/validate", {"email": email})
        if body.get("error"):
            return {"email": email, "status": "error",
                    "sub": str(body["error"])[:120]}
        return {"email": email,
                "status": (body.get("status") or "unknown").lower(),
                "sub": str(body.get("sub_status") or "")[:120]}
    except Exception as exc:  # noqa: BLE001
        return {"email": email, "status": "error",
                "sub": f"{type(exc).__name__}: {exc}"[:120]}


def _is_role(email: str) -> bool:
    return email.lower().startswith(ROLE_PREFIXES)


def main() -> int:
    sb = v2lib.supabase_client()
    errors: list[dict] = []

    res = (sb.table("leads").select("email")
           .is_("zb_status", "null").limit(BATCH).execute())
    candidates = [(r.get("email") or "") for r in (res.data or []) if r.get("email")]
    if not candidates:
        print("no unverified leads")
        return 0

    credits = _credits()
    print(f"zerobounce credits: {credits}, candidates: {len(candidates)}")
    role = [e for e in candidates if _is_role(e)]
    to_verify = [e for e in candidates if not _is_role(e)]
    budget = max(0, credits - CREDIT_RESERVE)
    if len(to_verify) > budget:
        print(f"credit budget covers {budget} of {len(to_verify)}; "
              f"remainder stays unverified")
        to_verify = to_verify[:budget]

    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for r in ex.map(_validate_one, to_verify):
            results.append(r)

    now = _now()
    rows = [{
        "email": e,
        "zb_status": "do_not_mail",
        "zb_substatus": "role_address",
        "zb_verified_at": now,
        "updated_at": now,
    } for e in role]
    for r in results:
        if r["status"] == "error":
            errors.append({"stage": "validate",
                           "error": f"{r['email']}: {r['sub']}"})
            continue
        rows.append({
            "email": r["email"],
            "zb_status": r["status"],
            "zb_substatus": r["sub"],
            "zb_verified_at": now,
            "updated_at": now,
        })
    # Partial upsert: only the zb_* columns + updated_at. PostgREST upsert is
    # whole-row, so merge against existing rows first to avoid clobbering.
    if rows:
        emails = [r["email"] for r in rows]
        existing: dict[str, dict] = {}
        for i in range(0, len(emails), 200):
            chunk = emails[i:i + 200]
            got = (sb.table("leads").select("*").in_("email", chunk).execute())
            for g in got.data or []:
                existing[(g.get("email") or "").lower()] = g
        merged = []
        for r in rows:
            base = existing.get(r["email"].lower()) or {"email": r["email"]}
            base.update(r)
            merged.append(base)
        v2lib.upsert(sb, "leads", merged, "email")

    from collections import Counter
    counts = Counter(r["zb_status"] for r in rows)
    # verification_runs is append-only: each run is a new row.
    sb.table("verification_runs").insert({
        "provider": "zerobounce",
        "list_name": "leads-catchup",
        "ran_at": now,
        "total": len(rows),
        "valid": counts.get("valid", 0),
        "invalid": counts.get("invalid", 0),
        "catch_all": counts.get("catch-all", 0) + counts.get("catch_all", 0),
        "do_not_mail": counts.get("do_not_mail", 0),
        "unknown": counts.get("unknown", 0),
        "credits_used": len(results),
    }).execute()

    v2lib.record_run(
        sb, "zerobounce",
        ok=not errors,
        stages=[{"stage": "validate", "ok": not errors,
                 "verified": len(rows), "role_skipped": len(role),
                 "credits_left": credits - len(results)}],
        errors=errors,
    )
    print(f"verified: {len(rows)} ({len(role)} role-skipped), "
          f"errors: {len(errors)}")
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
