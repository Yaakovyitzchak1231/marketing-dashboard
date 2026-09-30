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

Supabase access is raw PostgREST over urllib — no third-party package
needed (the OVH box has no pip). The fluent builder covers exactly the
operations the collectors use: select/eq/in_/is_/order/limit/insert/
upsert, each finished with .execute() returning an object with .data.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
import urllib.error

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


class _Result:
    """Mimics the supabase-py response shape the collectors expect."""

    def __init__(self, data, error=None):
        self.data = data
        self.error = error


class _Query:
    """Fluent PostgREST query builder for one table."""

    def __init__(self, client: "_RestClient", table: str):
        self._c = client
        self._table = table
        self._select = "*"
        self._params: list[tuple[str, str]] = []
        self._method = "GET"
        self._body: bytes | None = None
        self._prefer: list[str] = []
        self._on_conflict: str | None = None

    # -- builders ----------------------------------------------------
    def select(self, cols: str) -> "_Query":
        self._select = cols
        return self

    def eq(self, col: str, val) -> "_Query":
        self._params.append((col, f"eq.{val}"))
        return self

    def in_(self, col: str, vals: list) -> "_Query":
        inner = ",".join(str(v) for v in vals)
        self._params.append((col, f"in.({inner})"))
        return self

    def is_(self, col: str, val: str) -> "_Query":
        self._params.append((col, f"is.{val}"))
        return self

    def order(self, col: str, desc: bool = False) -> "_Query":
        self._params.append(("order", f"{col}.desc" if desc else f"{col}.asc"))
        return self

    def limit(self, n: int) -> "_Query":
        self._params.append(("limit", str(n)))
        return self

    def insert(self, row: dict) -> "_Query":
        self._method = "POST"
        self._body = json.dumps(row).encode()
        self._prefer.append("return=representation")
        return self

    def upsert(self, rows: list[dict], on_conflict: str) -> "_Query":
        self._method = "POST"
        self._body = json.dumps(rows).encode()
        self._on_conflict = on_conflict
        self._prefer.append("resolution=merge-duplicates")
        self._prefer.append("return=representation")
        return self

    # -- execution ---------------------------------------------------
    def execute(self) -> _Result:
        params = [("select", self._select)] + self._params
        if self._on_conflict:
            params.append(("on_conflict", self._on_conflict))
        # Quote each value but keep PostgREST operators (eq., in.(), etc.)
        # readable: encode the value part, not the operator prefix.
        qs_parts = []
        for k, v in params:
            qs_parts.append(
                f"{urllib.parse.quote(k, safe='')}="
                f"{urllib.parse.quote(v, safe='().,')}"
            )
        url = f"{self._c.base}/rest/v1/{self._table}?{'&'.join(qs_parts)}"
        headers = {
            "apikey": self._c.key,
            "Authorization": f"Bearer {self._c.key}",
            "Content-Type": "application/json",
        }
        if self._prefer:
            headers["Prefer"] = ", ".join(self._prefer)
        req = urllib.request.Request(url, data=self._body, headers=headers,
                                     method=self._method)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = resp.read().decode("utf-8")
                data = json.loads(raw) if raw.strip() else []
                return _Result(data)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:500]
            return _Result(None, error=f"HTTP {e.code}: {body}")


class _RestClient:
    """Minimal Supabase client: .table(name) -> fluent query builder."""

    def __init__(self, base: str, key: str):
        self.base = base.rstrip("/")
        self.key = key

    def table(self, name: str) -> _Query:
        return _Query(self, name)


def supabase_client() -> _RestClient:
    """Service-role client. Env vars win; vault surrogate is the fallback."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url:
        # SUPABASE_URL was never in the secrets file; derive from project ref
        # if the file gave us nothing.
        url = "https://zlbxjdueuhinywnovyoe.supabase.co"
    if not key:
        key = vault_surrogate("custom.supabase")
    if not key:
        raise RuntimeError(
            "SUPABASE_SERVICE_ROLE_KEY is not set and no custom.supabase "
            "vault credential is available"
        )
    # NOTE: when `key` is a hsurr:* surrogate, the Hatch egress proxy swaps
    # it for the real service key before it reaches *.supabase.co.
    return _RestClient(url, key)


def composio_mcp():
    """Composio MCP client. Vault surrogate on Hatch, profile config on OVH."""
    if _VAULT:
        sys.path.insert(0, os.path.expanduser("~/workspace/skills/composio/bin"))
        import composio_mcp as cm  # noqa: E402
        return cm.MCP()
    from composio_mcp import MCP  # noqa: E402  (OVH: profile-key variant)
    return MCP()


def upsert(sb: _RestClient, table: str, rows: list[dict], on_conflict: str) -> list[dict]:
    """Idempotent upsert. Empty list is a no-op, never a write of zeros."""
    if not rows:
        return []
    res = sb.table(table).upsert(rows, on_conflict=on_conflict).execute()
    if getattr(res, "error", None):
        raise RuntimeError(f"{table} upsert failed: {res.error}")
    return getattr(res, "data", None) or []


def record_run(sb: _RestClient, collector: str, *, ok: bool, stages: list[dict],
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
