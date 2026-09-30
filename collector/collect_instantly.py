#!/usr/bin/env python3
"""Instantly campaign collector for the marketing dashboard.

Runs as a plain script (cron, systemd, or by hand) -- no Hermes turn required --
because it talks to Composio's MCP endpoint directly via composio_mcp.MCP.

Why not LIST_CAMPAIGNS for the inventory: Composio returns large payloads as a
truncated `data_preview` that silently drops fields (name, status, most of
email_list) and re-encodes long arrays as the literal string "...146 more items".
Anything read off that preview would be a guess. So the collector uses the three
endpoints that come back whole:

  INSTANTLY_CAMPAIGNS_ANALYTICS_OVERVIEW_GET  -> account-wide totals (the KPI row)
  INSTANTLY_LIST_CAMPAIGNS                    -> campaign IDs only (ids survive truncation)
  INSTANTLY_GET_CAMPAIGN_ANALYTICS            -> per-campaign metrics, untruncated

Design rules, in priority order:
  1. Never invent a number. A failed call becomes an entry in `errors` and a
     null field, never a zero. Zero is a real measurement; null is "the API did
     not say".
  2. Recompute every rate from raw counts. Never average a rate.
  3. Write atomically -- the dashboard polls this file and must never read half
     of a document.
"""
from __future__ import annotations

import json
import os
import shlex
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from composio_mcp import MCP  # noqa: E402

ACCOUNT = "instantly_moline-parsec"
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
DATA_FILE = os.path.join(DATA_DIR, "dashboard.json")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")

# Instantly campaign status codes. Negative codes exist; they land in "unknown"
# rather than being folded into "paused".
STATUS = {0: "paused", 1: "active", 2: "draft", 3: "pending", 4: "archived"}

# Portfolio metrics the overview returns, beyond the per-campaign set.
OVERVIEW_FIELDS = [
    "contacted_count", "total_closed", "total_interested",
    "total_meeting_booked", "total_meeting_completed",
]

ANALYTIC_FIELDS = [
    "emails_sent_count", "new_leads_contacted_count", "leads_count",
    "contacted_count", "completed_count", "bounced_count",
    "unsubscribed_count", "reply_count", "reply_count_unique",
    "reply_count_automatic_unique", "open_count", "open_count_unique",
    "link_click_count", "link_click_count_unique",
    "total_opportunities", "total_opportunity_value",
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _err(stage: str, exc: Exception) -> dict:
    return {"stage": stage, "error": f"{type(exc).__name__}: {exc}", "at": _now()}


def _num(v):
    """Coerce to a number, or None. Never coerce a string to 0."""
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _sum_rows(rows: list[dict], field: str) -> int:
    return sum(_num(r.get(field)) or 0 for r in rows)


class Instantly:
    def __init__(self, mcp: MCP | None = None):
        self.mcp = mcp or MCP()
        self.calls = 0

    def call(self, slug: str, **args) -> dict:
        self.calls += 1
        raw = self.mcp.call("COMPOSIO_MULTI_EXECUTE_TOOL", {
            "tools": [{"tool_slug": slug, "arguments": {"account": ACCOUNT, **args}}]
        })
        if not raw.get("successful"):
            raise RuntimeError(f"{slug}: {raw.get('error')}")
        results = (raw.get("data") or {}).get("results") or []
        if not results:
            raise RuntimeError(
                f"{slug}: empty results (error_count={(raw.get('data') or {}).get('error_count')})"
            )
        resp = results[0].get("response") or {}
        if not resp.get("successful", True):
            raise RuntimeError(f"{slug}: {str(resp)[:200]}")
        # Small payloads arrive as `data`; large ones as a truncated
        # `data_preview` (string or dict) plus a pointer to a remote file
        # holding the COMPLETE response. Reading the preview silently drops
        # campaigns — its `items` array ends with the literal string
        # "...N more items" rather than real objects. Always resolve the
        # remote file first when one is advertised.
        remote_file = (raw.get("data") or {}).get("remote_file_info") or {}
        remote_path = remote_file.get("file_path")
        if remote_path:
            return self._read_remote_file(remote_path)

        if "data" in resp:
            return resp["data"]
        preview = resp.get("data_preview")
        if isinstance(preview, str):
            try:
                return json.loads(preview)
            except ValueError:
                return {}
        return preview if isinstance(preview, dict) else {}

    def _read_remote_file(self, path: str) -> dict:
        """Fetch the full payload Composio offloaded to its sandbox.

        The remote file holds the same envelope the inline response would have
        had, so parse it and unwrap to the `data` object. If anything about that
        fails we raise rather than fall back to a truncated preview: a short
        list that looks complete is worse than a loud failure, because every
        rate computed from it is wrong.
        """
        out = self.mcp.call("COMPOSIO_REMOTE_BASH_TOOL", {
            "command": (
                "cat " + shlex.quote(path) +
                " 2>/dev/null | head -c 20000000"
            )
        })
        stdout = (out.get("data") or {}).get("stdout")
        if not stdout:
            raise RuntimeError(
                f"remote file {path} returned no stdout "
                f"(error={str(out.get('error'))[:200]})"
            )
        try:
            envelope = json.loads(stdout)
        except ValueError as exc:
            raise RuntimeError(f"remote file {path} is not valid JSON: {exc}") from exc

        # Unwrap the same shapes an inline response can take.
        node = envelope
        for key in ("results", "response", "data"):
            if isinstance(node, dict) and key in node:
                node = node[key]
        if not isinstance(node, dict):
            raise RuntimeError(f"remote file {path}: unexpected envelope shape")
        if "data" in node and isinstance(node["data"], dict):
            return node["data"]
        return node

    # -- endpoints that return untruncated payloads -------------------------

    def overview(self) -> dict:
        """Account-wide totals. This is the authoritative KPI source."""
        data = self.call("INSTANTLY_CAMPAIGNS_ANALYTICS_OVERVIEW_GET")
        an = data.get("analytics")
        return an if isinstance(an, dict) else {}

    def senders(self) -> list[dict]:
        """Every sending mailbox with its warmup state.

        This is the deliverability layer: a portfolio reply rate is meaningless
        if the mailboxes behind it are cold or disconnected.
        """
        out: list[dict] = []
        cursor, guard = None, 0
        while guard < 40:
            guard += 1
            args = {"limit": 100}
            if cursor:
                args["starting_after"] = cursor
            data = self.call("INSTANTLY_LIST_ACCOUNTS", **args)
            for it in data.get("items") or []:
                if not isinstance(it, dict) or not it.get("email"):
                    continue
                warm = it.get("warmup") if isinstance(it.get("warmup"), dict) else {}
                email = it["email"]
                out.append({
                    "email": email,
                    "domain": email.split("@")[-1].lower() if "@" in email else None,
                    # 1 and 2 are Instantly's healthy statuses; 3 and below are
                    # not, and setup_pending is its own failure mode.
                    "status": _num(it.get("status")),
                    "setup_pending": bool(it.get("setup_pending")),
                    "daily_limit": _num(it.get("daily_limit")),
                    "warmup_score": _num(it.get("stat_warmup_score")),
                    "warmup_status": it.get("warmup_status"),
                    "warmup_increment": _num(warm.get("increment")),
                    "warmup_limit": _num(warm.get("limit")),
                    "warmup_reply_rate": _num(warm.get("reply_rate")),
                    "created": it.get("timestamp_created"),
                })
            nxt = data.get("next_starting_after")
            if not nxt or nxt == cursor:
                break
            cursor = nxt
        seen, deduped = set(), []
        for s in out:
            if s["email"] not in seen:
                seen.add(s["email"])
                deduped.append(s)
        return deduped

    def campaign_ids(self) -> list[str]:
        """Every campaign id. Reads from the remote file to bypass preview truncation."""
        # First call to get the remote file path
        result = self.mcp.call("COMPOSIO_MULTI_EXECUTE_TOOL", {
            "tools": [{"tool_slug": "INSTANTLY_LIST_CAMPAIGNS", "arguments": {"account": ACCOUNT, "limit": 100}}]
        })
        self.calls += 1
        if not result.get("successful"):
            raise RuntimeError(f"INSTANTLY_LIST_CAMPAIGNS: {result.get('error')}")
        data = (result.get("data") or {})
        results = data.get("results") or []
        if not results:
            raise RuntimeError("INSTANTLY_LIST_CAMPAIGNS: empty results")
        resp = results[0].get("response") or {}
        if not resp.get("successful", True):
            raise RuntimeError(f"INSTANTLY_LIST_CAMPAIGNS: {str(resp)[:200]}")
        
        # Get the remote file path
        remote_file = data.get("remote_file_info", {}).get("file_path")
        if not remote_file:
            # Fallback: try data_preview if no remote file (small payload)
            if "data" in resp:
                items = resp["data"].get("items") or []
            else:
                preview = resp.get("data_preview")
                if isinstance(preview, str):
                    try:
                        items = json.loads(preview).get("items") or []
                    except ValueError:
                        items = []
                elif isinstance(preview, dict):
                    items = preview.get("items") or []
                else:
                    items = []
        else:
            # Read full data from remote file using COMPOSIO_REMOTE_BASH_TOOL
            # We need to run a Python script in the sandbox to parse the JSON
            script = f'''
import json
with open("{remote_file}") as f:
    d = json.load(f)
items = d["results"][0]["response"]["data"]["items"]
for x in items:
    if x.get("id"):
        print(x["id"])
'''
            bash_result = self.mcp.call("COMPOSIO_REMOTE_WORKBENCH", {
                "code_to_execute": script
            })
            if not bash_result.get("successful"):
                raise RuntimeError(f"Failed to read remote file: {bash_result}")
            stdout = bash_result.get("data", {}).get("stdout", "").strip()
            if not stdout:
                raise RuntimeError("Empty stdout from remote file read")
            items = [{"id": line} for line in stdout.split("\n") if line]
        
        # Extract IDs
        ids = [it["id"] for it in items if isinstance(it, dict) and it.get("id")]
        
        # The preview can repeat a page; dedupe while preserving order.
        seen, out = set(), []
        for i in ids:
            if i not in seen:
                seen.add(i)
                out.append(i)
        return out

    def campaign(self, cid: str) -> dict:
        """One campaign's metrics, name and status -- all untruncated."""
        data = self.call("INSTANTLY_GET_CAMPAIGN_ANALYTICS", id=cid)
        items = data.get("items") or []
        row = items[0] if items else {}

        out: dict = {"id": cid, "name": None, "status_code": None,
                     "status": "unknown", "analytics": {}, "sending": {}}
        if row:
            code = _num(row.get("campaign_status"))
            out["name"] = row.get("campaign_name")
            out["status_code"] = code
            out["status"] = STATUS.get(code, "unknown")
            out["analytics"] = {
                f: _num(row.get(f)) for f in ANALYTIC_FIELDS if row.get(f) is not None
            }
        else:
            # A campaign with zero activity returns no items. That is a real
            # state (never launched), not a failed call.
            out["no_activity"] = True

        s = self.call("INSTANTLY_GET_CAMPAIGN_SENDING_STATUS", id=cid)
        if isinstance(s, dict):
            accounts = s.get("accounts_summary")
            if isinstance(accounts, list):  # shape varies by account tier
                accounts = {
                    "total_connected": len(accounts),
                    "available": sum(1 for a in accounts if _num(a.get("status")) in (1, 2)),
                }
            out["sending"] = {
                "accounts_summary": accounts if isinstance(accounts, dict) else {},
                "campaign_daily_limit": s.get("campaign_daily_limit", {}),
                "new_lead_limit": s.get("new_lead_limit", {}),
                "schedule_status": s.get("schedule_status", {}),
                "issue_tracking": s.get("issue_tracking", {}),
            }
        return out


def collect() -> dict:
    api = Instantly()
    errors: list[dict] = []
    run_started = _now()

    overview: dict = {}
    try:
        overview = api.overview()
    except Exception as exc:  # noqa: BLE001
        errors.append(_err("overview", exc))

    ids: list[str] = []
    try:
        ids = api.campaign_ids()
    except Exception as exc:  # noqa: BLE001
        errors.append(_err("list_campaigns", exc))

    campaigns: list[dict] = []
    for cid in ids:
        try:
            c = api.campaign(cid)
        except Exception as exc:  # noqa: BLE001
            errors.append(_err(f"campaign:{cid[:8]}", exc))
            continue
        if not c.get("name"):
            c["name"] = f"Campaign {cid[:8]}"
        campaigns.append(c)

    senders: list[dict] = []
    try:
        senders = api.senders()
    except Exception as exc:  # noqa: BLE001
        errors.append(_err("senders", exc))

    return {"overview": overview, "campaigns": campaigns, "senders": senders,
            "errors": errors, "calls": api.calls, "campaign_ids": ids,
            "run_started_at": run_started}


def rollup(overview: dict, campaigns: list[dict], senders: list[dict]) -> dict:
    """Portfolio totals.

    Account-wide figures come from the overview endpoint and are the
    authoritative KPI row. Per-campaign sums are kept alongside them so the
    table and the KPI row can be cross-checked -- a mismatch between the two is
    a real signal worth surfacing, not something to paper over.
    """
    active = [c for c in campaigns if c.get("status") == "active"]

    def s(c, *path):
        node = c.get("sending") or {}
        for p in path:
            if not isinstance(node, dict):
                return 0
            node = node.get(p)
        return _num(node) or 0

    t: dict = {
        # Surviving rows only -- NOT the inventory. Kept for dashboard.json's
        # local consumers, but it is wrong to render as the campaign count:
        # during a partial run it reported 5 for an 8-campaign account. The
        # honest counts are campaigns_inventory_count and
        # campaigns_collected_count, which persist() writes to accounts.
        "campaigns_total": len(campaigns),
        "campaigns_surviving": len(campaigns),
        "campaigns_active": len(active),
        "campaigns_paused": sum(1 for c in campaigns if c.get("status") == "paused"),
        "campaigns_draft": sum(1 for c in campaigns if c.get("status") == "draft"),
        "campaigns_unknown": sum(1 for c in campaigns if c.get("status") == "unknown"),
        "campaigns_no_activity": sum(1 for c in campaigns if c.get("no_activity")),
        "senders_connected": sum(s(c, "accounts_summary", "total_connected") for c in active),
        "senders_available": sum(s(c, "accounts_summary", "available") for c in active),
        "sent_today": sum(s(c, "campaign_daily_limit", "sent") for c in active),
        "daily_cap": sum(s(c, "campaign_daily_limit", "limit") for c in active),
    }

    rows = [c["analytics"] for c in campaigns]
    t["campaigns_sent"] = _sum_rows(rows, "emails_sent_count")
    t["campaigns_replies"] = _sum_rows(rows, "reply_count_unique")

    t["emails_sent"] = _num(overview.get("emails_sent_count"))
    t["replies"] = _num(overview.get("reply_count_unique"))
    t["replies_all"] = _num(overview.get("reply_count"))
    t["opens_unique"] = _num(overview.get("open_count_unique"))
    t["clicks_unique"] = _num(overview.get("link_click_count_unique"))
    t["bounced"] = _num(overview.get("bounced_count"))
    t["unsubscribed"] = _num(overview.get("unsubscribed_count"))
    t["contacted"] = _num(overview.get("contacted_count"))
    t["leads_contacted"] = _num(overview.get("new_leads_contacted_count"))
    t["opportunities"] = _num(overview.get("total_opportunities"))
    t["opportunity_value"] = _num(overview.get("total_opportunity_value"))
    for f in OVERVIEW_FIELDS:
        t[f] = _num(overview.get(f))

    # Rates: None when the denominator is zero or missing. "No sends yet" is
    # not "0% bounce rate".
    sent = t["emails_sent"]
    t["bounce_rate"] = (
        round(t["bounced"] / sent, 4) if sent and t["bounced"] is not None else None
    )
    t["unsub_rate"] = (
        round(t["unsubscribed"] / sent, 4) if sent and t["unsubscribed"] is not None else None
    )
    t["reply_rate"] = (
        round(t["replies"] / sent, 4) if sent and t["replies"] is not None else None
    )
    t["open_rate"] = (
        round(t["opens_unique"] / sent, 4) if sent and t["opens_unique"] is not None else None
    )
    t["opportunities_per_1k"] = (
        round(t["opportunities"] / sent * 1000, 2)
        if sent and t["opportunities"] is not None else None
    )
    cap = t["daily_cap"]
    t["daily_cap_used"] = round(t["sent_today"] / cap, 4) if cap else None
    conn = t["senders_connected"]
    t["sender_health"] = round(t["senders_available"] / conn, 4) if conn else None

    # Fleet-level deliverability, from the mailbox inventory rather than from
    # any single campaign's sending status.
    total = len(senders)
    healthy = sum(1 for s in senders if s.get("status") in (1, 2))
    scores = [s["warmup_score"] for s in senders if s.get("warmup_score") is not None]
    t["fleet_total"] = total
    t["fleet_healthy"] = healthy
    t["fleet_unhealthy"] = total - healthy
    t["fleet_setup_pending"] = sum(1 for s in senders if s.get("setup_pending"))
    t["fleet_domains"] = len({s["domain"] for s in senders if s.get("domain")})
    t["fleet_warmup_avg"] = round(sum(scores) / len(scores), 1) if scores else None
    t["fleet_warmup_min"] = min(scores) if scores else None
    t["fleet_warmup_cold"] = sum(1 for s in senders
                                 if (s.get("warmup_score") or 100) < 80)
    t["fleet_daily_limit"] = sum(_num(s.get("daily_limit")) or 0 for s in senders)
    return t


# =====================================================================
# Supabase persistence layer (T4)
#
# What changed from the flat-JSON prototype, and why:
#
#   1. Flat JSON was a whole-document overwrite, so two runs in the same
#      second raced and the dashboard could read a half-written file. Here
#      every write is a keyed upsert (`on_conflict`) against the natural key
#      of the row, so a repeat run converges on identical state instead of
#      appending. This is the idempotency requirement.
#   2. The prototype had no human/autoresponder split in the account rollup
#      -- it only had `replies` (which is reply_count_unique) and `replies_all`
#      (which is reply_count, autoresponders included). Nothing enforced that a
#      rate be derived from the human figure, so the bug that produced 333%
#      and 450% had nothing to stop it. `process_campaign_analytics` and
#      `compute_account_rates` now make the split explicit and compute every
#      rate from the human numerator.
#   3. The prototype stored rates it could not trust. `open_rate` and
#      `unsubscribe` are written as SQL NULL when the API does not populate
#      them. A zero there would be indistinguishable from a real measurement.
#   4. A failed API call used to leave a gap in a JSON blob. Here it is
#      recorded in the `collection_runs` health surface and the affected
#      metric columns are left untouched -- never set to 0.
#   5. Rows are daily rollups keyed on (campaign, date) and (date), not
#      per-collection rows, so the free tier's 500MB is never a concern.
#
# Every rate is recomputed here from raw counts. No rate is ever averaged.
# =====================================================================


# Reasons a rate is not publishable. These strings are the same ones T3's
# lib/rates.ts emits, because the collector stores the reason and the API reads
# it. If the two ever disagree, the UI renders a number the API called untrusted.
REASON_NOT_COLLECTED = "not_collected"
REASON_NO_SENDS = "no_sends"
REASON_NUMERATOR_EXCEEDS = "numerator_exceeds_denominator"
REASON_PARTIAL = "collector_error"
REASON_SOURCE_UNREPORTED = "source_not_reported"


def compute_rate(numerator, denominator, places: int = 4):
    """numerator/denominator, or None when either is absent or the base is 0.

    "No sends yet" is not "0% replied".

    This function deliberately does NOT gate rates above 1.0 -- `rate_gate`
    below owns that. The earlier version of this docstring claimed a rate over
    1.0 was "never a result worth printing" while the code returned 4.5 for the
    IRS Penalty Back campaign (9 unique replies from 2 sends). The claim was
    wrong; the code now enforces it.
    """
    n, d = _num(numerator), _num(denominator)
    if n is None or d is None or d == 0:
        return None
    return round(n / d, places)


def rate_gate(numerator, denominator, *, partial: bool = False,
              error_reason: str | None = None) -> tuple:
    """The publishability decision for one rate.

    Returns (rate, trusted, reason). Mirrors T3's `rateFrom` in lib/rates.ts.

    The >100% case is the important one. reply_count_unique exceeds
    emails_sent_count on two real campaigns (9 from 2, 10 from 3), which is
    arithmetically impossible. No other field in the payload resolves it:
    contacted_count and new_leads_contacted_count are <= emails_sent_count, and
    leads_count -- the largest at 4 -- is still below 9. The rate is therefore
    suppressed and the reason stored, rather than clamped to 100% (a claim) or
    published as 450% (the bug this dashboard exists to fix).

    A rate from a partial collection is arithmetically valid but is not a
    measurement of the campaign, so it is withheld and marked untrusted.
    """
    if partial or error_reason:
        return None, False, (error_reason or REASON_PARTIAL)
    n, d = _num(numerator), _num(denominator)
    if n is None or d is None:
        return None, False, REASON_NOT_COLLECTED
    if d <= 0:
        return None, False, REASON_NO_SENDS
    if n > d:
        return None, False, REASON_NUMERATOR_EXCEEDS
    return round(n / d, 4), True, None


# Instantly reports open and unsubscribe tracking as a hard 0 on every
# campaign and on the account overview. That is the API declining to populate
# the field, not a measurement of zero opens.
#
# The old `_reported` returned None for any value <= 0. That conflated two
# different things: "the API did not populate this" and "the API measured zero"
# and they are different claims. It also meant open_reported could never be set
# true, because a genuine zero opens would be discarded as unreported first.
#
# The rule below decides from evidence instead. A field is considered populated
# for this account if ANY campaign in the portfolio reports a non-zero count. If
# every campaign returns 0, the API is not populating the field, and a 0 on any
# individual campaign is a placeholder rather than a measurement.
#
# That distinction is the whole of bug 3. If Instantly starts populating opens
# tomorrow, the first run after the change reports open_reported = true and a
# genuine 0 renders as 0.0%, which is correct. Until then it renders as null.
def source_populates(overview: dict, campaigns: list[dict]) -> dict:
    """Which optional metrics Instantly actually populates for this account.

    Returns a dict of flag -> bool. Evaluated across the whole portfolio, not
    per campaign, because "does this API report opens at all" is an account
    property while "how many opens did this campaign get" is per campaign.
    """
    def any_positive(field: str) -> bool:
        o = overview.get(field) if isinstance(overview, dict) else None
        if (_num(o) or 0) > 0:
            return True
        for c in campaigns or []:
            a = (c.get("analytics") or {}) if isinstance(c, dict) else {}
            if (_num(a.get(field)) or 0) > 0:
                return True
        return False

    return {
        "open_reported": any_positive("open_count_unique"),
        "unsub_reported": any_positive("unsubscribed_count"),
    }


def _reported(value, populated: bool = False):
    """A count the API measured, or None when it did not populate the field.

    `populated` comes from source_populates(). When the source does not populate
    the field, a 0 is a placeholder and must become NULL. When it does populate,
    a 0 is a real measurement and is preserved -- otherwise a genuine 0 would
    be silently upgraded to "unknown", which is its own kind of lie.
    """
    n = _num(value)
    if n is None:
        return None
    if n == 0 and not populated:
        return None
    return n


def process_campaign_analytics(analytics: dict, *, populated: dict | None = None,
                                partial: bool = False,
                                error_reason: str | None = None) -> dict:
    """One campaign's analytics block -> the daily_metrics columns.

    Column names match migration 002 exactly. This is the contract the API
    routes read, so a rename here is a 500 on /api/campaigns.

    The reply counters are stored raw and independent:
      replies_unique            <- reply_count_unique
      replies_automatic_unique  <- reply_count_automatic_unique
      replies_all               <- reply_count

    There is deliberately NO replies_human column. On the TapDash campaign
    reply_count_automatic_unique is 10 against reply_count_unique of 8, so
    unique - automatic = -2. The automatic counter is not a subset of the
    unique one; they are separate counters over different populations. Any
    derived "human" count would be a negative number that passes every rate
    check because -2/2126 looks like a valid percentage.

    No rate is stored. Rates are recomputed by the API from raw counts on every
    read, so a stored rate cannot go stale. What IS stored is the trust decision
    and its reason, so the UI's words and the API's number cannot disagree.
    """
    a = analytics if isinstance(analytics, dict) else {}
    populated = populated or {}
    sent = _num(a.get("emails_sent_count"))

    reply_rate, reply_trusted, reply_reason = rate_gate(
        a.get("reply_count_unique"), sent,
        partial=partial, error_reason=error_reason)
    bounce_rate, bounce_trusted, bounce_reason = rate_gate(
        a.get("bounced_count"), sent,
        partial=partial, error_reason=error_reason)

    return {
        "emails_sent": sent,
        "contacted_count": _num(a.get("contacted_count")),
        "new_leads_contacted": _num(a.get("new_leads_contacted_count")),
        "leads_count": _num(a.get("leads_count")),

        "replies_unique": _num(a.get("reply_count_unique")),
        "replies_automatic_unique": _num(a.get("reply_count_automatic_unique")),
        "replies_all": _num(a.get("reply_count")),

        "bounces": _num(a.get("bounced_count")),
        "opportunities": _num(a.get("total_opportunities")),
        "opportunity_value": _num(a.get("total_opportunity_value")),

        # Raw counts, not rates. The API derives the rate and knows to return
        # null because open_reported is false.
        "opens_unique": _reported(a.get("open_count_unique"),
                                  populated.get("open_reported", False)),
        "unsubscribed": _reported(a.get("unsubscribed_count"),
                                  populated.get("unsub_reported", False)),
        "open_reported": bool(populated.get("open_reported", False)),
        "unsub_reported": bool(populated.get("unsub_reported", False)),

        "denominator_source": "emails_sent",
        "rate_trusted": reply_trusted,
        "rate_untrusted_reason": reply_reason,
        "bounce_rate_trusted": bounce_trusted,
        "bounce_rate_untrusted_reason": bounce_reason,
        "partial": partial,

        # Retained for the local print path and dashboard.json. Never persisted.
        "_reply_rate": reply_rate,
        "_bounce_rate": bounce_rate,
    }


def build_daily_metrics(campaign: dict, campaign_id: str,
                        metric_date: str | None = None, *,
                        populated: dict | None = None, partial: bool = False,
                        error_reason: str | None = None) -> dict:
    """The row to upsert into daily_metrics for one campaign on one day."""
    m = process_campaign_analytics(
        campaign.get("analytics") or {}, populated=populated,
        partial=partial, error_reason=error_reason)
    day = metric_date or datetime.now(timezone.utc).date().isoformat()
    # No per-run timestamp: a second run on the same day must produce a
    # byte-identical row. `metric_date` is the stable key and the database
    # fills collected_at via its DEFAULT. Adding _now() here broke the
    # idempotency guarantee that AC1 asserts.
    return {
        "campaign_id": campaign_id,
        "metric_date": day,
        **{k: v for k, v in m.items() if not k.startswith("_")},
    }


def compute_account_rates(overview: dict, senders: list[dict] | None = None,
                          *, campaigns: list[dict] | None = None,
                          inventory_count: int | None = None,
                          partial: bool = False) -> dict:
    """Account-wide raw counts -> the accounts row.

    Column names match migration 002. The reply counters are the same three
    independent raw values as the per-campaign rows; there is no replies_human
    column at any level.

    opens_unique and unsubscribed are stored as raw counts beside their
    open_reported / unsub_reported flags. The API reads the FLAGS, not the
    count's truthiness, which is how a placeholder 0 becomes null instead of
    0.0%. When INSTANTLY_LIST_ACCOUNTS fails, mailbox_count and healthy_mailboxes
    are None rather than 0 -- "we did not ask" is not "zero mailboxes".
    """
    o = overview if isinstance(overview, dict) else {}
    senders = senders or []
    sent = _num(o.get("emails_sent_count"))
    populated = source_populates(o, campaigns or [])

    reply_rate, reply_trusted, reply_reason = rate_gate(
        o.get("reply_count_unique"), sent, partial=partial)
    bounce_rate, bounce_trusted, bounce_reason = rate_gate(
        o.get("bounced_count"), sent, partial=partial)

    return {
        "emails_sent": sent,
        "contacted_count": _num(o.get("contacted_count")),
        "new_leads_contacted": _num(o.get("new_leads_contacted_count")),

        "replies_unique": _num(o.get("reply_count_unique")),
        "replies_automatic_unique": _num(o.get("reply_count_automatic_unique")),
        "replies_all": _num(o.get("reply_count")),

        "bounces": _num(o.get("bounced_count")),
        "unsubscribed": _reported(o.get("unsubscribed_count"),
                                  populated["unsub_reported"]),
        "opportunities": _num(o.get("total_opportunities")),
        "opportunity_value": _num(o.get("total_opportunity_value")),

        "opens_unique": _reported(o.get("open_count_unique"),
                                  populated["open_reported"]),
        "open_reported": populated["open_reported"],
        "unsub_reported": populated["unsub_reported"],

        "mailbox_count": len(senders) if senders else None,
        "healthy_mailboxes": (
            sum(1 for s in senders if _num(s.get("status")) in (1, 2))
            if senders else None
        ),
        "warmup_score_avg": _warmup_avg(senders),

        "denominator_source": "emails_sent",
        "rate_trusted": reply_trusted,
        "rate_untrusted_reason": reply_reason,
        "bounce_rate_trusted": bounce_trusted,
        "bounce_rate_untrusted_reason": bounce_reason,
        "partial": partial,

        # The truncation canary. campaign_inventory_count is how many ids the
        # collector found; campaign_collected_count is how many of those
        # produced a row. When they differ the portfolio is short and the
        # headline total is computed from a subset.
        "campaigns_inventory_count": inventory_count,
        "campaigns_collected_count": None,   # filled by persist()

        "_reply_rate": reply_rate,
        "_bounce_rate": bounce_rate,
    }


def _warmup_avg(senders: list[dict]):
    """Mean warmup score, or None. An average of raw scores, never of a rate."""
    scores = [_num(s.get("warmup_score")) for s in senders]
    scores = [x for x in scores if x is not None]
    return round(sum(scores) / len(scores), 1) if scores else None


# ---------------------------------------------------------------------
# Upserts. Every one is keyed on the row's natural key so a second run
# with identical input leaves the table byte-identical.
# ---------------------------------------------------------------------


def _upsert(sb, table: str, rows: list[dict], on_conflict: str) -> list[dict]:
    """Upsert `rows` into `table`, or raise. Never a blind insert.

    An empty list is a no-op, not an error: an empty read is a valid state
    and must not become a write of zeros.
    """
    if not rows:
        return []
    res = sb.table(table).upsert(rows, on_conflict=on_conflict).execute()
    if getattr(res, "error", None):
        raise RuntimeError(f"{table} upsert failed: {res.error}")
    return getattr(res, "data", None) or []


def upsert_campaigns(sb, campaigns: list[dict]) -> list[dict]:
    """Identity rows. Keyed on the Instantly campaign id."""
    rows = [{
        "external_id": c["id"],
        "name": c.get("name") or f"Campaign {str(c['id'])[:8]}",
        "status": c.get("status") or "unknown",
        "created_at": c.get("created_at") or _now(),
    } for c in campaigns if c.get("id")]
    return _upsert(sb, "campaigns", rows, "external_id")


def upsert_daily_metrics(sb, metrics: list[dict]) -> list[dict]:
    """One row per (campaign, day). Re-running the same day is a no-op."""
    return _upsert(sb, "daily_metrics", metrics, "campaign_id,metric_date")


def upsert_accounts(sb, accounts: list[dict]) -> list[dict]:
    """One row per day."""
    return _upsert(sb, "accounts", accounts, "metric_date")


def record_run(sb, *, ok: bool, stages: list[dict], api_calls: int,
               campaigns: int, campaign_id_map: dict[str, str],
               errors: list[dict]) -> None:
    """The health surface. A failed call is a row here, never a zero.

    `campaigns_collected` vs `campaigns_persisted` is the truncation canary:
    if those ever diverge, the inventory is short and the numbers on the page
    are computed from a partial portfolio.
    """
    row = {
        "ran_at": _now(),
        "ok": ok,
        "api_calls": api_calls,
        "campaigns_collected": campaigns,
        "campaigns_persisted": len(campaign_id_map),
        "stages": stages,
        "errors": errors,
    }
    _upsert(sb, "collection_runs", [row], "ran_at")


def supabase_client():
    """Build a Supabase client from the environment.

    Requires a key that may WRITE (service_role) -- the anon key is bound by
    RLS and cannot upsert. The key is read from SUPABASE_SERVICE_ROLE_KEY and
    is never logged, never written to the repo, and never leaves this process.
    """
    from supabase import create_client  # imported here so unit tests need no SDK

    url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url:
        raise RuntimeError("SUPABASE_URL is not set")
    if not key:
        raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY is not set")
    return create_client(url, key)


# The inventory is the set of ids found; the collected set is what produced a
# row. They are equal on a clean run. On a run where a per-campaign API call
# 502s they are not, and the difference is portfolio volume the page never saw.
def _failed_campaign_ids(errors: list[dict]) -> set[str]:
    """Campaign external_ids named by an error entry."""
    out = set()
    for e in errors or []:
        stage = str(e.get("stage") or "")
        if stage.startswith("campaign:"):
            out.add(stage.split(":", 1)[1])
    return out


def _split_stage(stage: str) -> tuple[str, str | None]:
    if ":" in stage:
        prefix, cid = stage.split(":", 1)
        return prefix, cid
    return stage, None


def record_collection_errors(sb, errors: list[dict],
                            run_started_at: str | None = None) -> int:
    """One row per failed call, in `collection_errors`.

    This is the feed T3's /api/collection-errors reads for the partial-data
    banner, and it is the ONLY source of "N of M campaigns collected". The
    banner's count must be the collector's count, never a UI guess and never
    len(campaigns) -- that is how 5 surviving rows came to be reported as the
    portfolio.

    Errors are appended, not upserted: each run's failures are a new
    observation. `resolved` defaults FALSE so the banner shows until a later
    clean run resolves them.
    """
    rows = []
    for e in errors or []:
        stage = str(e.get("stage") or "unknown")
        _, cid = _split_stage(stage)
        rows.append({
            # The collector's own error timestamp, which is part of the
            # observation. Not _now(): re-running would insert a fresh row for
            # a failure that has not changed, and the banner would show the
            # same outage once per run.
            "collected_at": e.get("at") or run_started_at or _now(),
            "run_started_at": run_started_at or e.get("at") or _now(),
            "stage": stage,
            "campaign_external_id": cid,
            "error": str(e.get("error") or "")[:2000],
            "resolved": False,
        })
    _upsert(sb, "collection_errors", rows, "collected_at,stage,campaign_external_id")
    return len(rows)


def persist(sb, got: dict, metric_date: str | None = None,
            inventory_count: int | None = None) -> dict:
    """Write one collection into Supabase. Idempotent by construction."""
    day = metric_date or datetime.now(timezone.utc).date().isoformat()
    campaigns, overview, senders = got["campaigns"], got["overview"], got["senders"]
    errors = got.get("errors") or []
    run_started = got.get("run_started_at") or _now()

    # Which campaigns failed to collect. A campaign with no analytics block is
    # a partial row even when its identity upsert succeeded.
    failed = _failed_campaign_ids(errors)
    inventory = inventory_count if inventory_count is not None else len(got.get("campaign_ids") or []) or len(campaigns)

    # 1. Identity first: daily_metrics needs the campaigns.id uuid, which is
    #    only known after the upsert returns it.
    campaign_rows = upsert_campaigns(sb, campaigns)
    id_map = {
        r["external_id"]: r["id"]
        for r in campaign_rows
        if r and r.get("external_id") and r.get("id")
    }

    # 2. A campaign whose identity upsert failed has no uuid, so it gets no
    #    metrics row. Writing one with a null campaign_id would let a partial
    #    failure look like a complete day.
    missing = [c["id"] for c in campaigns
               if c.get("id") and c["id"] not in id_map]

    populated = source_populates(overview, campaigns)
    metrics = []
    for c in campaigns:
        cid = c.get("id")
        if not cid or cid not in id_map:
            continue
        short = str(cid)[:8]
        is_partial = short in failed or bool(c.get("partial"))
        metrics.append(build_daily_metrics(
            c, id_map[cid], metric_date=day, populated=populated,
            partial=is_partial,
            error_reason=f"campaign:{short}" if is_partial else None))
    upsert_daily_metrics(sb, metrics)

    # 3. Account rollup. Skipped entirely when the overview call failed --
    #    an accounts row built from an empty overview would be a row of
    #    NULLs that reads as "zero activity" rather than "we could not ask".
    account_rows: list[dict] = []
    partial_run = bool(errors) or bool(missing)
    if overview:
        rates = compute_account_rates(
            overview, senders, campaigns=campaigns,
            inventory_count=inventory, partial=partial_run)
        rates["campaigns_collected_count"] = len(metrics)
        account_rows = [{
            **{k: v for k, v in rates.items() if not k.startswith("_")},
            "metric_date": day,
        }]
        upsert_accounts(sb, account_rows)

    # 4. Per-campaign errors so the banner can name a failed campaign. Account
    #    level stages have no campaign id and belong in the run record.
    record_collection_errors(sb, errors, run_started_at=run_started)

    record_run(
        sb,
        ok=bool(overview) and not errors and not missing,
        stages=[{"stage": "overview", "ok": bool(overview)},
                {"stage": "campaigns", "ok": len(metrics),
                 "expected": inventory}],
        api_calls=got["calls"],
        campaigns=len(campaigns),
        campaign_id_map=id_map,
        errors=errors + [{"stage": "campaign_identity_missing",
                          "error": f"{len(missing)} campaign(s) had no id after upsert"}]
        if missing else errors,
    )
    return {"campaign_rows": len(campaign_rows), "metric_rows": len(metrics),
            "account_rows": len(account_rows), "identity_missing": missing,
            "inventory_count": inventory, "collected_count": len(metrics),
            "partial": partial_run, "populated": populated}


def write_history(totals: dict) -> None:
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    hist: list[dict] = []
    if os.path.exists(HISTORY_FILE):
        try:
            hist = json.load(open(HISTORY_FILE))
        except (OSError, ValueError):
            hist = []
    hist = [h for h in hist if h.get("day") != day]
    hist.append({"day": day, "at": int(time.time()), **totals})
    hist.sort(key=lambda h: h["day"])
    with open(HISTORY_FILE, "w") as fh:
        json.dump(hist[-120:], fh, indent=2)


def main() -> int:
    os.makedirs(DATA_DIR, exist_ok=True)
    got = collect()
    errors, campaigns = got["errors"], got["campaigns"]
    totals = rollup(got["overview"], campaigns, got["senders"])

    payload = {
        "generated_at": _now(),
        "account": ACCOUNT,
        "source": "instantly overview + per-campaign analytics + sender fleet via composio mcp",
        "ok": totals["emails_sent"] is not None and not errors,
        "api_calls": got["calls"],
        "errors": errors,
        "totals": totals,
        "campaigns": campaigns,
        "senders": got["senders"],
    }

    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(payload, fh, indent=2)
    os.replace(tmp, DATA_FILE)

    if totals["emails_sent"] is not None:
        write_history(totals)

    print(json.dumps({
        "campaigns": totals["campaigns_total"],
        "active": totals["campaigns_active"],
        "emails_sent": totals["emails_sent"],
        "replies": totals["replies"],
        "reply_rate": totals["reply_rate"],
        "bounce_rate": totals["bounce_rate"],
        "opportunity_value": totals["opportunity_value"],
        "fleet_total": totals["fleet_total"],
        "fleet_healthy": totals["fleet_healthy"],
        "fleet_warmup_avg": totals["fleet_warmup_avg"],
        "errors": len(errors),
        "api_calls": got["calls"],
    }))
    for e in errors[:6]:
        print(f"  ! {e['stage']}: {e['error'][:110]}", file=sys.stderr)
    return 0 if totals["emails_sent"] is not None else 1


if __name__ == "__main__":
    sys.exit(main())
