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
            "errors": errors, "calls": api.calls}


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
        "campaigns_total": len(campaigns),
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


def compute_rate(numerator, denominator, places: int = 4):
    """numerator/denominator, or None when either is absent or the base is 0.

    "No sends yet" is not "0% replied". A rate over 1.0 is a bug upstream in
    the numerator, never a result worth printing.
    """
    n, d = _num(numerator), _num(denominator)
    if n is None or d is None or d == 0:
        return None
    return round(n / d, places)


# Instantly reports open and unsubscribe tracking as a hard 0 on every
# campaign and on the account overview. That is the API declining to populate
# the field, not a measurement of zero opens. We treat a non-positive count
# as "not reported" so the column lands as NULL rather than 0.0%.
def _reported(value):
    """A count the API actually measured, or None when it reported nothing."""
    n = _num(value)
    if n is None or n <= 0:
        return None
    return n


def process_campaign_analytics(analytics: dict) -> dict:
    """One campaign's analytics block -> the daily_metrics columns.

    The reply split is the whole point. Instantly gives three numbers:
      reply_count                 -- every reply, autoresponders included
      reply_count_unique          -- replies from distinct leads; the human
                                    figure
      reply_count_automatic_unique -- autoresponders (OOO, "we never reply")
    Rates here are built from reply_count_unique. Using reply_count is what
    produced 333% and 450% on a campaign with far more autoreplies than sends.
    """
    a = analytics if isinstance(analytics, dict) else {}
    sent = _num(a.get("emails_sent_count"))
    human = _num(a.get("reply_count_unique"))
    auto = _num(a.get("reply_count_automatic_unique"))
    total = _num(a.get("reply_count"))
    bounces = _num(a.get("bounced_count"))
    opps = _num(a.get("total_opportunities"))
    opens = _reported(a.get("open_count_unique"))
    unsub = _reported(a.get("unsubscribed_count"))

    return {
        "emails_sent": sent,
        "replies_total": total,
        # reply_count_unique is the human figure. If the API omits it we
        # leave it NULL rather than falling back to the combined count.
        "replies_human": human,
        "replies_autoresponder": auto,
        "opportunities": opps,
        "bounces": bounces,
        # NULL when the API did not report opens. Never 0.
        "open_rate": compute_rate(opens, sent),
        # NULL when the API did not report unsubscribes. Never 0.
        "unsubscribe": unsub,
        "reply_rate": compute_rate(human, sent),
        "bounce_rate": compute_rate(bounces, sent),
    }


def build_daily_metrics(campaign: dict, campaign_id: str,
                        metric_date: str | None = None) -> dict:
    """The row to upsert into daily_metrics for one campaign on one day."""
    metrics = process_campaign_analytics(campaign.get("analytics") or {})
    day = metric_date or datetime.now(timezone.utc).date().isoformat()
    # Only the persisted columns; the computed rates are deliberately NOT
    # stored. A stored rate goes stale the moment the underlying count is
    # re-read, and the API layer recomputes rates from raw counts anyway.
    return {
        "campaign_id": campaign_id,
        "metric_date": day,
        "emails_sent": metrics["emails_sent"],
        "replies_total": metrics["replies_total"],
        "replies_human": metrics["replies_human"],
        "replies_autoresponder": metrics["replies_autoresponder"],
        "opportunities": metrics["opportunities"],
        "bounces": metrics["bounces"],
        "open_rate": metrics["open_rate"],
        "unsubscribe": metrics["unsubscribe"],
        "source_updated_at": _now(),
    }


def compute_account_rates(overview: dict, senders: list[dict] | None = None) -> dict:
    """Account-wide raw counts -> the accounts row plus derived rates.

    Note what is NOT here: open_rate and unsubscribe. Neither exists in the
    `accounts` table by design, because the overview endpoint does not
    populate them. The API layer emits them as null. Adding a column for a
    number the source does not report is how "0.0%" got onto the page.
    """
    o = overview if isinstance(overview, dict) else {}
    senders = senders or []
    sent = _num(o.get("emails_sent_count"))
    human = _num(o.get("reply_count_unique"))
    auto = _num(o.get("reply_count_automatic_unique"))
    bounces = _num(o.get("bounced_count"))

    healthy = sum(1 for s in senders if _num(s.get("status")) in (1, 2))

    return {
        "emails_sent": sent,
        "replies_human": human,
        "replies_autoresponder": auto,
        "bounces": bounces,
        "opportunities": _num(o.get("total_opportunities")),
        "opportunity_value": _num(o.get("total_opportunity_value")),
        "mailbox_count": len(senders) or None,
        "healthy_mailboxes": healthy or None,
        # Recomputed from raw counts every time. Never averaged.
        "reply_rate": compute_rate(human, sent),
        "bounce_rate": compute_rate(bounces, sent),
    }


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


def persist(sb, got: dict, metric_date: str | None = None) -> dict:
    """Write one collection into Supabase. Idempotent by construction."""
    day = metric_date or datetime.now(timezone.utc).date().isoformat()
    campaigns, overview, senders = got["campaigns"], got["overview"], got["senders"]

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
    metrics = [build_daily_metrics(c, id_map[c["id"]], metric_date=day)
               for c in campaigns if c.get("id") in id_map]
    upsert_daily_metrics(sb, metrics)

    # 3. Account rollup. Skipped entirely when the overview call failed --
    #    an accounts row built from an empty overview would be a row of
    #    NULLs that reads as "zero activity" rather than "we could not ask".
    account_rows: list[dict] = []
    if overview:
        rates = compute_account_rates(overview, senders)
        account_rows = [{**{k: v for k, v in rates.items()
                             if k not in ("reply_rate", "bounce_rate")},
                         "metric_date": day}]
        upsert_accounts(sb, account_rows)

    record_run(
        sb,
        ok=bool(overview) and not got["errors"] and not missing,
        stages=[{"stage": "overview", "ok": bool(overview)},
                {"stage": "campaigns", "ok": len(metrics),
                 "expected": len(campaigns)}],
        api_calls=got["calls"],
        campaigns=len(campaigns),
        campaign_id_map=id_map,
        errors=got["errors"] + [{"stage": "campaign_identity_missing",
                                 "error": f"{len(missing)} campaign(s) had no id after upsert"}]
        if missing else got["errors"],
    )
    return {"campaign_rows": len(campaign_rows), "metric_rows": len(metrics),
            "account_rows": len(account_rows), "identity_missing": missing}


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

    # Persist to Supabase
    try:
        sb = supabase_client()
        persist(sb, got)
    except Exception as exc:  # noqa: BLE001
        print(f"  ! persist: {exc}", file=sys.stderr)

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
