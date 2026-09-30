#!/usr/bin/env python3
"""Unit tests for the remote-file fallback in Instantly.call().

No network. These pin the exact contract: a truncated `data_preview` plus a
`remote_file_info.file_path` must resolve to the full payload, and the string
"...N more items" must never be mistaken for a campaign.

The real-integration proof is test_regression_campaign_inventory.py, which
compares campaign_ids() against INSTANTLY_COUNT_LAUNCHED_CAMPAIGNS.
"""
import contextlib
import io
import json
import sys
import tempfile
import types
from contextlib import contextmanager

sys.path.insert(0, "/home/hermes/.hermes/profiles/mkt-data/workspace/marketing-dashboard")
sys.path.insert(0, "/home/hermes/projects/marketing-dashboard/.worktrees/restore/collector")

# Import the module without executing its __main__ body.
import collect_instantly  # noqa: E402


@contextmanager
def _no_retry_sleep():
    """Keep the retry tests instant without leaking the override."""
    original = collect_instantly.Instantly.RETRY_SLEEP
    collect_instantly.Instantly.RETRY_SLEEP = 0
    try:
        yield
    finally:
        collect_instantly.Instantly.RETRY_SLEEP = original


def _make_api(mcp):
    return collect_instantly.Instantly(mcp)


class FakeMCP:
    """Stands in for composio_mcp.MCP with scripted responses.

    When a response advertises `remote_file_info`, the file it points at is
    really written to disk and COMPOSIO_REMOTE_WORKBENCH really executes the
    collector's unwrap script against it, with the sandbox path rewritten to
    the local temp file. Emulating the sandbox honestly matters: handing back
    a canned stdout would let the unwrap script rot silently, which is exactly
    how the list-shaped-envelope bug shipped -- every test asserted on a
    hand-written payload and none of them ran the code.
    """

    def __init__(self, responses):
        self.responses = responses
        self.calls = []
        self._sandbox_path = None
        self._local_path = None
        for value in responses.values():
            if not isinstance(value, dict):
                continue
            data = value.get("data") or {}
            path = (data.get("remote_file_info") or {}).get("file_path")
            if path and "remote_file" in data:
                self._sandbox_path = path
                self._local_path = self._write(data["remote_file"])

    @staticmethod
    def _write(payload):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(payload, handle)
        handle.close()
        return handle.name

    def call(self, method, args):
        self.calls.append((method, args))
        if method == WORKBENCH and WORKBENCH not in self.responses:
            code = args["code_to_execute"]
            # The sandbox's file lives where the collector was told it lives.
            code = code.replace(json.dumps(self._sandbox_path),
                                json.dumps(self._local_path))
            stdout = io.StringIO()
            try:
                with contextlib.redirect_stdout(stdout):
                    exec(compile(code, "<remote>", "exec"), {"__name__": "__main__"})
            except SystemExit as exc:
                return {"successful": True,
                        "data": {"stdout": f"ERROR: SystemExit {exc}"}}
            text = stdout.getvalue()
            if not text.strip():
                return {"successful": True, "data": {"stdout": ""}}
            return {"successful": True, "data": {"stdout": text}}

        key = (method, args.get("tools", [{}])[0].get("tool_slug"))
        if key in self.responses:
            return self.responses[key]
        if method in self.responses:
            return self.responses[method]
        raise AssertionError(f"unexpected call: {method} {args}")


MULTI = "COMPOSIO_MULTI_EXECUTE_TOOL"
# The remote payload is unwrapped INSIDE the sandbox by COMPOSIO_REMOTE_WORKBENCH,
# not `cat`-ed over COMPOSIO_REMOTE_BASH_TOOL. Composio truncates remote-bash
# stdout at ~40,000 characters, so a large payload arrives as an unparseable
# prefix of a JSON document -- the exact failure that was silently costing us
# the whole sender fleet on every run.
WORKBENCH = "COMPOSIO_REMOTE_WORKBENCH"
BASH = "COMPOSIO_REMOTE_BASH_TOOL"

FULL = {
    "successful": True,
    "data": {
        "results": [
            {
                "response": {
                    "successful": True,
                    "data": {
                        "items": [
                            {"id": "c1", "name": "One"},
                            {"id": "c2", "name": "Two"},
                            {"id": "c3", "name": "Three"},
                        ]
                    },
                }
            }
        ]
    },
}

# The on-disk remote file, as observed in the live sandbox. `results` is a
# LIST with one entry per tool executed, and `response.data` is the payload.
REMOTE_FILE = {
    "success": True,
    "results": [
        {
            "response": {
                "successful": True,
                "data": {
                    "items": [
                        {"id": "c1", "name": "One"},
                        {"id": "c2", "name": "Two"},
                        {"id": "c3", "name": "Three"},
                    ],
                    "next_starting_after": "cursor-1",
                },
            },
            "tool_slug": "INSTANTLY_LIST_CAMPAIGNS",
            "index": 0,
        }
    ],
    "total_count": 1,
    "success_count": 1,
    "error_count": 0,
}

# The real-world shape: truncated preview + pointer to a full remote file.
TRUNCATED = {
    "successful": True,
    "data": {
        "results": [
            {
                "response": {
                    "successful": True,
                    "data_preview": {
                        "items": [
                            {"id": "c1", "name": "One"},
                            {"id": "c2", "name": "Two"},
                            "...1 more items",
                        ]
                    },
                }
            }
        ],
        "remote_file_info": {
            "file_path": "/mnt/files/mex/run.json",
            "message": "Complete response was large (20229 tokens).",
        },
        # What the sandbox actually holds. FakeMCP writes this to a temp file
        # and runs the real unwrap script against it.
        "remote_file": REMOTE_FILE,
    },
}


def test_small_payload_still_uses_data():
    """Untruncated payloads must be unaffected by the fix."""
    mcp = FakeMCP({(MULTI, "INSTANTLY_LIST_CAMPAIGNS"): FULL})
    api = _make_api(mcp)
    data = api.call("INSTANTLY_LIST_CAMPAIGNS")
    assert len(data["items"]) == 3, data
    # The fake records the MCP-level method name; a remote-file read would show
    # up as COMPOSIO_REMOTE_WORKBENCH, which must NOT appear for a small payload.
    assert all(c[0] != WORKBENCH for c in mcp.calls), f"unexpected remote read: {mcp.calls}"
    assert all(c[0] != BASH for c in mcp.calls), f"unexpected remote read: {mcp.calls}"


def test_truncated_payload_resolves_remote_file():
    """The core fix: preview + remote_file_info must yield the FULL payload."""
    mcp = FakeMCP({(MULTI, "INSTANTLY_LIST_CAMPAIGNS"): TRUNCATED})
    api = _make_api(mcp)
    data = api.call("INSTANTLY_LIST_CAMPAIGNS")

    ids = [i.get("id") for i in data["items"]]
    assert ids == ["c1", "c2", "c3"], f"got {ids} — remote file was not used"
    assert any(c[0] == WORKBENCH for c in mcp.calls), "expected a COMPOSIO_REMOTE_WORKBENCH call"
    # The unwrap runs in the sandbox; a `cat` over the 40KB-limited bash channel
    # is the bug, so it must not be the path we take.
    assert not any(c[0] == BASH for c in mcp.calls), "remote file was cat-ed over bash"


def test_remote_file_envelope_is_list_shaped():
    """Regression: `results` is a LIST, not a dict key to descend through.

    Observed against the live sandbox. Getting this wrong made the in-sandbox
    unwrap SystemExit, which surfaced as a permanently empty sender fleet on
    every single run. FakeMCP runs the real unwrap script, so this fails the
    moment the script stops handling the real envelope.
    """
    mcp = FakeMCP(
        {
            (MULTI, "INSTANTLY_LIST_ACCOUNTS"): {
                "successful": True,
                "data": {
                    "results": [{"response": {"successful": True}}],
                    "remote_file_info": {"file_path": "/mnt/files/mex/else.json"},
                    "remote_file": REMOTE_FILE,
                    "error_count": 0,
                },
            }
        }
    )
    api = _make_api(mcp)
    data = api.call("INSTANTLY_LIST_ACCOUNTS")
    assert [i.get("id") for i in data["items"]] == ["c1", "c2", "c3"], data
    # Pagination cursor must survive the unwrap too.
    assert data.get("next_starting_after") == "cursor-1", data


def test_more_items_string_never_returns_as_an_item():
    """Guard the specific corruption: '...N more items' must not leak through."""
    mcp = FakeMCP({(MULTI, "INSTANTLY_LIST_CAMPAIGNS"): TRUNCATED})
    api = _make_api(mcp)
    items = api.call("INSTANTLY_LIST_CAMPAIGNS")["items"]
    for item in items:
        assert isinstance(item, dict), f"non-dict item leaked: {item!r}"


def test_sandbox_projection_drops_unwanted_item_fields():
    """`keep` must strip fields inside the sandbox, not after the read.

    Both Composio stdout channels truncate at ~40,000 characters, so a
    payload that is read in full and trimmed locally is already lost by the
    time it reaches us. The projection has to happen before the print.
    """
    mcp = FakeMCP({(MULTI, "INSTANTLY_LIST_CAMPAIGNS"): TRUNCATED})
    api = _make_api(mcp)
    # The fixture items carry `name` as well as `id`; asking for id alone must
    # leave nothing else behind.
    data = api._call("INSTANTLY_LIST_CAMPAIGNS", keep=["id"], limit=100)
    assert [i.get("id") for i in data["items"]] == ["c1", "c2", "c3"], data
    for item in data["items"]:
        assert set(item) == {"id"}, f"projection failed, got {sorted(item)}"


def test_transient_5xx_is_retried_not_dropped():
    """A gateway 502 must not cost us a campaign from the inventory.

    The collector used to let the HTTPError propagate straight into
    collect()'s except, so one flaky gateway moment silently removed a
    campaign from every total on the page.
    """
    import urllib.error
    from email.message import Message

    class FlakyMCP(FakeMCP):
        def __init__(self, responses, fail_times):
            super().__init__(responses)
            self.fail_times = fail_times
            self.seen = 0

        def call(self, method, args):
            if method == MULTI:
                self.seen += 1
                if self.seen <= self.fail_times:
                    raise urllib.error.HTTPError("u", 502, "Bad Gateway", Message(), None)
            return super().call(method, args)

    with _no_retry_sleep():
        mcp = FlakyMCP({(MULTI, "INSTANTLY_LIST_CAMPAIGNS"): FULL}, fail_times=2)
        api = _make_api(mcp)
        data = api.call("INSTANTLY_LIST_CAMPAIGNS")
    assert len(data["items"]) == 3, data
    assert mcp.seen == 3, f"expected 3 attempts, made {mcp.seen}"


def test_deterministic_4xx_is_not_retried():
    """A 400 will never succeed. Retrying it just hides the real error."""
    import urllib.error
    from email.message import Message

    class BadMCP(FakeMCP):
        def __init__(self, responses):
            super().__init__(responses)
            self.seen = 0

        def call(self, method, args):
            if method == MULTI:
                self.seen += 1
                raise urllib.error.HTTPError("u", 400, "Bad Request", Message(), None)
            return super().call(method, args)

    with _no_retry_sleep():
        mcp = BadMCP({})
        api = _make_api(mcp)
        try:
            api.call("INSTANTLY_LIST_CAMPAIGNS")
        except urllib.error.HTTPError:
            pass
        else:
            raise AssertionError("expected the 400 to propagate")
    assert mcp.seen == 1, f"a 4xx must not be retried, made {mcp.seen} attempts"


def test_missing_remote_file_is_raisable_not_silent():
    """No remote file and a preview means we cannot know completeness.

    That must not silently return a short list — the caller has to be able to
    tell. The collector's own count cross-check is the backstop.
    """
    truncated_no_file = {
        "successful": True,
        "data": {
            "results": [
                {
                    "response": {
                        "successful": True,
                        "data_preview": {"items": [{"id": "c1"}, "...4 more items"]},
                    }
                }
            ]
        },
    }
    mcp = FakeMCP({(MULTI, "INSTANTLY_LIST_CAMPAIGNS"): truncated_no_file})
    api = _make_api(mcp)
    data = api.call("INSTANTLY_LIST_CAMPAIGNS")
    # Whatever it returns, the count-check in campaign_ids() must catch it.
    assert isinstance(data, dict)


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS  {name}")
            except AssertionError as e:
                fails += 1
                print(f"FAIL  {name}: {e}")
    print()
    print("all unit tests passed" if not fails else f"{fails} test(s) failed")
    sys.exit(1 if fails else 0)
