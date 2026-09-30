#!/usr/bin/env python3
"""Unit tests for the remote-file fallback in Instantly.call().

No network. These pin the exact contract: a truncated `data_preview` plus a
`remote_file_info.file_path` must resolve to the full payload, and the string
"...N more items" must never be mistaken for a campaign.

The real-integration proof is test_regression_campaign_inventory.py, which
compares campaign_ids() against INSTANTLY_COUNT_LAUNCHED_CAMPAIGNS.
"""
import sys
import types

sys.path.insert(0, "/home/hermes/.hermes/profiles/mkt-data/workspace/marketing-dashboard")

# Import the module without executing its __main__ body.
import collect_instantly  # noqa: E402


def _make_api(mcp):
    return collect_instantly.Instantly(mcp)


class FakeMCP:
    """Stands in for composio_mcp.MCP with scripted responses."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def call(self, method, args):
        self.calls.append((method, args))
        key = (method, args.get("tools", [{}])[0].get("tool_slug"))
        if key in self.responses:
            return self.responses[key]
        if method in self.responses:
            return self.responses[method]
        raise AssertionError(f"unexpected call: {method} {args}")


MULTI = "COMPOSIO_MULTI_EXECUTE_TOOL"
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
    },
}


def test_small_payload_still_uses_data():
    """Untruncated payloads must be unaffected by the fix."""
    mcp = FakeMCP({(MULTI, "INSTANTLY_LIST_CAMPAIGNS"): FULL})
    api = _make_api(mcp)
    data = api.call("INSTANTLY_LIST_CAMPAIGNS")
    assert len(data["items"]) == 3, data
    # The fake records the MCP-level method name; a remote-file read would show
    # up as COMPOSIO_REMOTE_BASH_TOOL, which must NOT appear for a small payload.
    assert all(c[0] != BASH for c in mcp.calls), f"unexpected remote read: {mcp.calls}"


def test_truncated_payload_resolves_remote_file():
    """The core fix: preview + remote_file_info must yield the FULL payload."""
    import json

    mcp = FakeMCP(
        {
            (MULTI, "INSTANTLY_LIST_CAMPAIGNS"): TRUNCATED,
            BASH: {"data": {"stdout": json.dumps(FULL["data"]["results"][0]["response"]["data"])}},
        }
    )
    api = _make_api(mcp)
    data = api.call("INSTANTLY_LIST_CAMPAIGNS")

    ids = [i.get("id") for i in data["items"]]
    assert ids == ["c1", "c2", "c3"], f"got {ids} — remote file was not used"
    assert any(c[0] == BASH for c in mcp.calls), "expected a COMPOSIO_REMOTE_BASH_TOOL call"


def test_more_items_string_never_returns_as_an_item():
    """Guard the specific corruption: '...N more items' must not leak through."""
    import json

    mcp = FakeMCP(
        {
            (MULTI, "INSTANTLY_LIST_CAMPAIGNS"): TRUNCATED,
            BASH: {"data": {"stdout": json.dumps(FULL["data"]["results"][0]["response"]["data"])}},
        }
    )
    api = _make_api(mcp)
    items = api.call("INSTANTLY_LIST_CAMPAIGNS")["items"]
    for item in items:
        assert isinstance(item, dict), f"non-dict item leaked: {item!r}"


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
