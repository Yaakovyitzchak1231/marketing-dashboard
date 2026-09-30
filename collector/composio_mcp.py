#!/usr/bin/env python3
"""Minimal MCP client for Composio's hosted server.

Exists because the Instantly tools are only reachable through Composio's MCP
endpoint, and the in-session tool wrapper mangles the nested array-of-object
arguments that Composio's meta-tools require. Talking JSON-RPC over HTTP
directly is scriptable, which is what the dashboard collector needs.

Usage:
    python3 composio_mcp.py list                       # tool names
    python3 composio_mcp.py tools INSTANTLY             # full schemas
    python3 composio_mcp.py call <TOOL> '<json-args>'  # invoke
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

URL = "https://connect.composio.dev/mcp"
CFG = "/home/hermes/.hermes/profiles/mkt-data/config.yaml"
PROTO = "2024-11-05"

# Composio's edge returns intermittent 502s on a single request. Those are
# transport faults, not answers. Four attempts with linear backoff clears them
# without turning a real outage into a silent partial collection.
RETRIES = 4
BACKOFF = 2.0


def consumer_key() -> str:
    """Pull x-consumer-api-key out of the profile's composio mcp block."""
    in_block = False
    for line in open(CFG):
        stripped = line.strip()
        if stripped == "composio:":
            in_block = True
            continue
        if in_block:
            if stripped.startswith("x-consumer-api-key:"):
                return stripped.split(":", 1)[1].strip().strip("'\"")
            if line and not line.startswith("    ") and stripped:
                break
    raise RuntimeError("composio x-consumer-api-key not found in config")


class MCP:
    def __init__(self):
        self.key = consumer_key()
        self.session = None
        self._id = 0
        self._rpc("initialize", {
            "protocolVersion": PROTO,
            "capabilities": {},
            "clientInfo": {"name": "marketing-dashboard", "version": "1"},
        })
        # The server requires a session for subsequent calls; capture the header.
        self._rpc("notifications/initialized", {})

    def _post(self, payload: dict) -> dict:
        headers = {
            "x-consumer-api-key": self.key,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session:
            headers["mcp-session-id"] = self.session
        req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers=headers)
        # Composio's edge intermittently answers 502 with no useful body. That
        # is a transport fault, not an answer, so retry with backoff. Without
        # this the collector died at session init often enough to make a manual
        # re-run the recovery mechanism -- and a manual re-run is exactly how a
        # half-written collection reaches the database.
        last: Exception | None = None
        for attempt in range(1, RETRIES + 1):
            try:
                with urllib.request.urlopen(req, timeout=180) as resp:
                    sid = resp.headers.get("mcp-session-id")
                    if sid:
                        self.session = sid
                    body = resp.read().decode("utf-8", "replace")
                break
            except urllib.error.HTTPError as exc:
                if exc.code < 500 and exc.code != 429:
                    raise
                last = exc
            except (urllib.error.URLError, TimeoutError) as exc:
                last = exc
            if attempt < RETRIES:
                time.sleep(BACKOFF * attempt)
        else:
            raise RuntimeError(f"{URL}: {RETRIES} attempts failed: "
                               f"{type(last).__name__}: {last}")
        # Streamable HTTP returns either bare JSON or SSE frames.
        if not body.strip():
            return {}  # e.g. the 202-no-content reply to notifications/initialized
        if body.lstrip().startswith("{"):
            return json.loads(body)
        for line in body.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        raise RuntimeError(f"unparseable MCP response: {body[:200]}")

    def _rpc(self, method: str, params: dict) -> dict:
        self._id += 1
        out = self._post({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params})
        if isinstance(out, dict) and "error" in out:
            raise RuntimeError(f"{method}: {out['error']}")
        return out.get("result", {})

    def list_tools(self) -> list[dict]:
        tools, cursor = [], None
        while True:
            params = {"cursor": cursor} if cursor else {}
            res = self._rpc("tools/list", params)
            tools.extend(res.get("tools", []))
            cursor = res.get("nextCursor")
            if not cursor:
                return tools

    def call(self, name: str, args: dict) -> dict:
        res = self._rpc("tools/call", {"name": name, "arguments": args})
        if res.get("isError"):
            raise RuntimeError(f"{name} errored: {res}")
        parts = []
        for c in res.get("content", []):
            if c.get("type") == "text":
                parts.append(c["text"])
        text = "\n".join(parts)
        try:
            return json.loads(text)
        except ValueError:
            return {"raw": text}


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    mcp = MCP()

    if cmd == "list":
        for t in sorted(mcp.list_tools(), key=lambda x: x["name"]):
            print(t["name"])
    elif cmd == "tools":
        needle = sys.argv[2].upper() if len(sys.argv) > 2 else ""
        for t in mcp.list_tools():
            if needle in t["name"].upper():
                print(f"\n### {t['name']}")
                print((t.get("description") or "")[:400])
                print(json.dumps(t.get("inputSchema", {}), indent=1)[:1200])
    elif cmd == "call":
        name = sys.argv[2]
        args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        print(json.dumps(mcp.call(name, args), indent=1)[:4000])
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
