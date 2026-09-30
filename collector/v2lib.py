#!/usr/bin/env python3
"""Shared helpers for the v2 collectors.

Runs on either machine:
  - Hatch VM: credentials come from the Secure Vault via surrogates
    (custom.composio, custom.zerobounce, custom.supabase). Nothing with a
    raw secret ever touches disk here.
  - OVH box: credentials come from environment variables, or from the
    Hermes secrets file (/home/hermes/jewelry-handoff/incoming/secrets/
    searxng-stack.env, mode 600) which is read at import. The vault has
    no surrogate mechanism there.

Precedence for every secret: explicit env var > Hermes secrets file
(OVH only) > vault surrogate (Hatch only). Values are never printed.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Vault surrogate machinery exists only on the Hatch VM.
try:
    sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
    from dynamic_credentials import dynamic_credential_entry  # noqa: E402
    _VAULT = True
except ImportError:
    _VAULT = False


def vault_surrogate(credential: str, entry: str = "access_token") -> str | None:
    """Return the hsurr:* surrogate for a vault credential, or None."""
    if not _VAULT:
        return None
    try:
        return dynamic_credential_entry(credential, entry)["surrogate"]
    except Exception:
        return None


# Hermes keeps Porkbun/InboxKit (and other) keys in a mode-600 env file.
# On the OVH box, read it at import so collectors see the keys as env vars.
# Values are never printed, copied, or written anywhere else.
_HERMES_SECRETS_FILE = "/home/hermes/jewelry-handoff/incoming/secrets/searxng-stack.env"


def load_hermes_secrets() -> list[str]:
    """Load KEY=VALUE pairs from the Hermes secrets file into os.environ.

    Only fills keys that are not already set — explicit env vars win.
    Returns the list of key names loaded (never values). No-op when the
    file is absent or unreadable (e.g. on the Hatch VM).
    """
    loaded: list[str] = []
    try:
        with open(_HERMES_SECRETS_FILE, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return loaded
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        # Skip `export KEY=...` form and empty assignments (missing key).
        if key.startswith("export "):
            key = key[len("export "):].strip()
        if not key or not value or key in os.environ:
            continue
        os.environ[key] = value
        loaded.append(key)
    return loaded


load_hermes_secrets()


def supabase_client():
    """Service-role client. Env vars win; vault surrogate is the fallback."""
    from supabase import create_client

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url:
        raise RuntimeError("SUPABASE_URL is not set")
    if not key:
        key = vault_surrogate("custom.supabase")
    if not key:
        raise RuntimeError(
            "SUPABASE_SERVICE_ROLE_KEY is not set and no custom.supabase "
            "vault credential is available"
        )
    # NOTE: when `key` is a hsurr:* surrogate, the Hatch egress proxy swaps
    # it for the real service key before it reaches *.supabase.co.
    return create_client(url, key)


def composio_mcp():
    """Composio MCP client. Vault surrogate on Hatch, profile config on OVH."""
    if _VAULT:
        sys.path.insert(0, os.path.expanduser("~/workspace/skills/composio/bin"))
        import composio_mcp as cm  # noqa: E402
        return cm.MCP()
    from composio_mcp import MCP  # noqa: E402  (OVH: profile-key variant)
    return MCP()


def upsert(sb, table: str, rows: list[dict], on_conflict: str) -> list[dict]:
    """Idempotent upsert. Empty list is a no-op, never a write of zeros."""
    if not rows:
        return []
    res = sb.table(table).upsert(rows, on_conflict=on_conflict).execute()
    if getattr(res, "error", None):
        raise RuntimeError(f"{table} upsert failed: {res.error}")
    return getattr(res, "data", None) or []


def record_run(sb, collector: str, *, ok: bool, stages: list[dict],
               api_calls: int = 0, errors: list[dict] | None = None) -> None:
    """Health surface: a failed collection is a row here, never a zero."""
    from datetime import datetime, timezone
    upsert(sb, "collection_runs", [{
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "collector": collector,
        "ok": ok,
        "api_calls": api_calls,
        "stages": stages,
        "errors": errors or [],
    }], "collector,ran_at")
